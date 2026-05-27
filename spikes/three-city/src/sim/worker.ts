/**
 * 模拟 Worker 主循环（迭代 2 · E2 · 沿 RoadGraph 的 trip 派发）
 */

import { AgentStore, TripPhase } from './agents';
import { BuildingStore, kindToUse, BuildingUse } from './buildings';
import { DistrictStore, stepDistricts } from './districts';
import { ChainStore, stepChain } from './economy/chain';
import { LineStore, stepLines, type VehicleId } from './economy/lines';
import { PROD, RES, getProducer } from './economy/catalog';
import type { NodeId } from './economy/types';
import { stepEconomy, seedInitialPopulation, type CityMetrics, type CommuteSignal } from './economy';
import { packSnapshot, SnapshotPool } from './snapshot';
import { stepTick } from './tick';
import { TrafficStore, type RoadRegion } from './traffic';
import { pathing, type PathContext } from './pathing';
import { AgentState, AgentKind } from './types';
import {
  GRID_SIZE as DEFAULT_GRID,
  TICK_HZ,
  TICK_MS,
  TICKS_PER_DAY,
  type CityMetricsSnapshot,
  type SimSnapshot,
  type SimStats,
  type BuildingDelta,
  type DistrictSnapshot,
  type ChainSnapshotItem,
  type LineSnapshotItem,
} from './types';
import type { BuildingSpec } from '../render/buildingInstances';

interface SimConfig {
  /** 兼容字段：等价于 gridSizeX，正方形地图时只传这一个就够。 */
  gridSize: number;
  /** 矩形地图时传；缺省 = gridSize（向后兼容）。 */
  gridSizeX?: number;
  /** 矩形地图时传；缺省 = gridSize（向后兼容）。 */
  gridSizeZ?: number;
  seed: number;
  buildings: BuildingSpec[];
  maxVisibleAgents: number;
  roads: RoadRegion[];
  /** 迭代 3 新增：街区布局（由主线程 scene 模块计算后传入）。 */
  districts?: DistrictInitSpec[];
}

/** 主线程传入的街区初始化描述。 */
export interface DistrictInitSpec {
  col: number;
  row: number;
  zone: 0 | 1 | 2;        // BuildingUse
  bounds: { x: number; z: number; w: number; d: number };
  maxBuildings: number;
}

interface InitMsg  { type: 'init';  config: SimConfig }
interface ResetMsg { type: 'reset'; config: SimConfig }
interface PauseMsg  { type: 'pause' }
interface ResumeMsg { type: 'resume' }
interface ReturnBufferMsg { type: 'return-buffer'; buffer: ArrayBuffer }
interface BoostRoadMsg { type: 'boost-road'; parentRoadId: number; multiplier: number }
interface SetSpeedMsg { type: 'set-speed'; multiplier: number }      // E5：0=暂停, 1, 2, 4
/** 迭代 3 R3：玩家铺路 */
interface AddRoadMsg {
  type: 'add-road';
  playerId: number;       // RoadTool 端 segment id（worker 用它做 remove 回引）
  seg: { x: number; z: number; w: number; d: number; capacity: number };
}
/** 迭代 3 R3：玩家拆路 */
interface RemoveRoadMsg { type: 'remove-road'; playerId: number }

type IncomingMsg = InitMsg | ResetMsg | PauseMsg | ResumeMsg | ReturnBufferMsg | BoostRoadMsg | SetSpeedMsg | AddRoadMsg | RemoveRoadMsg;

const agentStore = new AgentStore();
const buildingStore = new BuildingStore();
const districtStore = new DistrictStore();
const chainStore = new ChainStore();
const lineStore = new LineStore();
const pool = new SnapshotPool();
let trafficStore: TrafficStore | null = null;
let pathContext: PathContext | null = null;
let randomFn: () => number = Math.random;

let tickInterval: ReturnType<typeof setInterval> | null = null;
let tickCount = 0;
let paused = false;
/** E5：倍速。0=暂停，1/2/4=对应倍速；与 paused 双重控制兼容 P 键。 */
let speedMultiplier = 1;
let maxVisibleAgents = 1000;
let gridSize = DEFAULT_GRID;
let taxAccumulated = 0;
let lastMetrics: CityMetrics | null = null;

// 迭代 3 C3：运输线本 tick 利润 / 累计利润
const tickProfitAccum = { value: 0 };
let profitPerTick = 0;
let profitAccumulated = 0;

const RESPAWN_EVERY_N_TICK = 60;     // 增量补人节奏（不再替换全部）

let residentialIdx: number[] = [];
let workIdx: number[] = [];

const tickMsRing = new Float32Array(60);
let tickMsIdx = 0;
let lastTickMs = 0;
let lastRateAt = performance.now();
let lastRateTicks = 0;
let ticksPerSec = 0;

let pendingRespawn = false;

/** 迭代 3：本 tick 待发送给主线程的建筑增删差量。 */
const pendingBuildingDeltas: { spawned: BuildingDelta[]; removed: number[] } = {
  spawned: [],
  removed: [],
};

/** 把 BuildingUse → BuildingKind 映射到 spec 上（spawn 时用）。 */
function useToKind(use: BuildingUse): BuildingDelta['kind'] {
  if (use === BuildingUse.Residential) return 0;
  if (use === BuildingUse.Commercial) return 1;
  return 2;
}

/** 取街区 zone 对应的 building kind（grow 时确定新建筑类别）。 */
function zoneToUse(zone: 0 | 1 | 2): BuildingUse {
  if (zone === 0) return BuildingUse.Residential;
  if (zone === 1) return BuildingUse.Commercial;
  return BuildingUse.Industrial;
}

// === E3 · 通勤时间反馈 ======================================================
/** 滑动窗口：最近 N 次到达 work 的 trip ticks。 */
const COMMUTE_WINDOW = 64;
const commuteWindow = new Float32Array(COMMUTE_WINDOW);
let commuteIdx = 0;
let commuteFilled = 0;
let commuteSum = 0;
/** 容忍上限：自由流通勤大约 8 秒（4Hz × 8 ≈ 32 tick），起步先用 28 tick。 */
const COMMUTE_TARGET_TICKS = 28;
/** 路径成本飙升触发的"全局缓存失效"频率上限：每 30 tick 最多一次。 */
const REPLAN_COOLDOWN_TICK = 30;
let lastReplanTick = -1000;

function recordCommute(ticks: number): void {
  if (commuteFilled === COMMUTE_WINDOW) {
    commuteSum -= commuteWindow[commuteIdx];
  } else {
    commuteFilled++;
  }
  commuteWindow[commuteIdx] = ticks;
  commuteSum += ticks;
  commuteIdx = (commuteIdx + 1) % COMMUTE_WINDOW;
}

function getCommuteSignal(): CommuteSignal {
  return {
    avgCommuteTicks: commuteFilled > 0 ? commuteSum / commuteFilled : 0,
    targetCommuteTicks: COMMUTE_TARGET_TICKS,
  };
}

function resetCommute(): void {
  commuteWindow.fill(0);
  commuteIdx = 0;
  commuteFilled = 0;
  commuteSum = 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box-Muller 标准正态分布。 */
function gaussian(rng: () => number): number {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function buildingEntry(i: number): { x: number; z: number } {
  return {
    x: buildingStore.x[i] + buildingStore.w[i] / 2,
    z: buildingStore.z[i] + buildingStore.d[i] / 2,
  };
}

/** 从 RoadGraph 反推 NS/EW 中心列表（保留兼容字段，主要用于 HUD/兜底）。 */
function makePathContext(traffic: TrafficStore): PathContext {
  const ns = new Set<number>();
  const ew = new Set<number>();
  for (const e of traffic.graph.edges) {
    if (e.axis === 'NS') ns.add(traffic.graph.nodes[e.from].x);
    else ew.add(traffic.graph.nodes[e.from].z);
  }
  return {
    graph: traffic.graph,
    nsRoadCenters: [...ns].sort((a, b) => a - b),
    ewRoadCenters: [...ew].sort((a, b) => a - b),
  };
}

function initWorld(cfg: SimConfig): void {
  agentStore.reset();
  buildingStore.reset();
  districtStore.reset();
  chainStore.reset();
  lineStore.reset();
  taxAccumulated = 0;
  profitPerTick = 0;
  profitAccumulated = 0;
  residentialIdx = [];
  workIdx = [];
  gridSize = cfg.gridSize;
  const gridX = cfg.gridSizeX ?? cfg.gridSize;
  const gridZ = cfg.gridSizeZ ?? cfg.gridSize;
  maxVisibleAgents = cfg.maxVisibleAgents;
  trafficStore = new TrafficStore(cfg.roads, gridX, gridZ);
  // E3：拥堵 EMA 调慢一档（C3 默认 0.25，避免抖动闪烁）
  trafficStore.setEma(0.15);
  randomFn = mulberry32(cfg.seed);

  pathContext = makePathContext(trafficStore);
  pathing.invalidate();
  resetCommute();
  lastReplanTick = -1000;
  pendingBuildingDeltas.spawned.length = 0;
  pendingBuildingDeltas.removed.length = 0;

  // 1) 注册街区
  if (cfg.districts && cfg.districts.length > 0) {
    districtStore.initFromLayout(cfg.districts.map((d) => ({
      col: d.col,
      row: d.row,
      zone: d.zone as BuildingUse,
      bounds: d.bounds,
      maxBuildings: d.maxBuildings,
    })));
  }

  // 2) 注册建筑（与原行为相同），并把每栋归属到街区
  for (const b of cfg.buildings) {
    const use = kindToUse(b.kind);
    const idx = buildingStore.spawn(b.x, b.z, b.w, b.d, b.h, use, 0);
    if (idx < 0) break;
    if (use === BuildingUse.Residential) residentialIdx.push(idx);
    else workIdx.push(idx);
    districtStore.assignBuilding(idx, b.x, b.z, b.w, b.d);
  }

  seedInitialPopulation(buildingStore, 4);

  // 迭代 3 Phase 2 spike：在地图固定位置预先放几个产业节点，
  // 让 ChainStore 一启动就有数据，便于后续 C3 TransportLine 验证。
  // 后续 Phase 5（UI 建产业）后这段会被玩家手动放置替代。
  const seeded = seedDemoProducers(gridX, gridZ);

  // 迭代 3 Phase 2 C3：建几条 demo 运输线（producer ↔ producer），
  // T1 接入城市消费后会再加 producer → town 线
  seedDemoLines(seeded);

  spawnVisibleAgents();
  pendingRespawn = true;
}

interface SeededProducers {
  farm?: NodeId;
  forest?: NodeId;
  sawMill?: NodeId;
  foodPlant?: NodeId;
  factory?: NodeId;
  pos: Map<NodeId, { x: number; z: number }>;
}

/**
 * 在地图四角各放一种产业（farm / forest / sawMill / foodPlant + factory）。
 * 用现有 BuildingStore.spawn 走"工业建筑"渲染，同时 chainStore.spawn 接经济。
 */
function seedDemoProducers(gridX: number, gridZ: number): SeededProducers {
  const seeds: Array<{ key: keyof Omit<SeededProducers, 'pos'>; pid: typeof PROD[keyof typeof PROD]; x: number; z: number }> = [
    { key: 'farm',      pid: PROD.farm,      x: gridX * 0.10, z: gridZ * 0.15 },
    { key: 'forest',    pid: PROD.forest,    x: gridX * 0.10, z: gridZ * 0.75 },
    { key: 'foodPlant', pid: PROD.foodPlant, x: gridX * 0.45, z: gridZ * 0.15 },
    { key: 'sawMill',   pid: PROD.sawMill,   x: gridX * 0.45, z: gridZ * 0.75 },
    { key: 'factory',   pid: PROD.factory,   x: gridX * 0.78, z: gridZ * 0.45 },
  ];
  const out: SeededProducers = { pos: new Map() };
  for (const s of seeds) {
    const def = getProducer(s.pid);
    const w = def.footprint.w;
    const d = def.footprint.d;
    const x = s.x - w / 2;
    const z = s.z - d / 2;
    if (x < 1 || z < 1 || x + w > gridX - 1 || z + d > gridZ - 1) continue;
    const idx = buildingStore.spawn(x, z, w, d, def.defaultHeight, BuildingUse.Industrial, 0);
    if (idx < 0) continue;
    workIdx.push(idx);
    districtStore.assignBuilding(idx, x, z, w, d);
    const nid = chainStore.spawn(s.pid, idx, s.x, s.z);
    out[s.key] = nid;
    out.pos.set(nid, { x: s.x, z: s.z });
  }
  return out;
}

/** 建 3 条 demo 货运线：farm→foodPlant、forest→sawMill、sawMill→factory。 */
function seedDemoLines(s: SeededProducers): void {
  const link = (
    srcId: NodeId | undefined,
    dstId: NodeId | undefined,
    res: typeof RES[keyof typeof RES],
    vh: VehicleId,
    fleet: number,
  ) => {
    if (srcId === undefined || dstId === undefined) return;
    const sp = s.pos.get(srcId);
    const dp = s.pos.get(dstId);
    if (!sp || !dp) return;
    lineStore.create({
      src: srcId, dst: dstId,
      resource: res,
      vehicleId: vh,
      fleetSize: fleet,
      dstKind: 'producer',
      srcPos: sp, dstPos: dp,
    });
  };
  link(s.farm,    s.foodPlant, RES.grain,  'truck-small', 2);
  link(s.forest,  s.sawMill,   RES.logs,   'truck-small', 2);
  link(s.sawMill, s.factory,   RES.planks, 'truck-large', 2);

  // 迭代 3 T1：再建 producer → town 线（食品厂 → 最近的商业街区）
  if (s.foodPlant !== undefined) {
    const fp = s.pos.get(s.foodPlant)!;
    const commercial = findNearestCommercialDistrict(fp.x, fp.z);
    if (commercial) {
      lineStore.create({
        src: s.foodPlant,
        dst: commercial.id as unknown as NodeId,
        resource: RES.food,
        vehicleId: 'truck-large',
        fleetSize: 2,
        dstKind: 'town',
        dstTownDistrictId: commercial.id,
        srcPos: fp,
        dstPos: commercial.pos,
      });
    }
  }
  // factory → 最近的工业街区（materials）
  if (s.factory !== undefined) {
    const fp = s.pos.get(s.factory)!;
    const industrial = findNearestIndustrialDistrict(fp.x, fp.z);
    if (industrial) {
      lineStore.create({
        src: s.factory,
        dst: industrial.id as unknown as NodeId,
        resource: RES.materials,
        vehicleId: 'truck-large',
        fleetSize: 2,
        dstKind: 'town',
        dstTownDistrictId: industrial.id,
        srcPos: fp,
        dstPos: industrial.pos,
      });
    }
  }
}

function findNearestCommercialDistrict(x: number, z: number): { id: number; pos: { x: number; z: number } } | null {
  return findNearestDistrict(x, z, BuildingUse.Commercial);
}
function findNearestIndustrialDistrict(x: number, z: number): { id: number; pos: { x: number; z: number } } | null {
  return findNearestDistrict(x, z, BuildingUse.Industrial);
}
function findNearestDistrict(x: number, z: number, zone: BuildingUse): { id: number; pos: { x: number; z: number } } | null {
  let best: { id: number; pos: { x: number; z: number } } | null = null;
  let bd = Infinity;
  for (const dist of districtStore.districts) {
    if (dist.zone !== zone) continue;
    const cx = dist.bounds.x + dist.bounds.w / 2;
    const cz = dist.bounds.z + dist.bounds.d / 2;
    const dx = cx - x;
    const dz = cz - z;
    const d2 = dx * dx + dz * dz;
    if (d2 < bd) {
      bd = d2;
      best = { id: dist.id, pos: { x: cx, z: cz } };
    }
  }
  return best;
}

/**
 * 采样可见代理。
 *
 * 迭代 3 R2：通勤 agent 降级为"装饰性可见居民"。
 * 目标数从"按城市人口 × 0.15"改为"按 district 数 × 25"，
 * 与城市经济**解耦**——它们不再驱动满意度，只负责"画面是活的"。
 *
 * 仍走 home↔work 循环（看起来像通勤），但 worker 不会把他们的通勤时长
 * 反馈到 economy.ts；commute 窗口的数据从 R1 起也只用于 HUD 观察。
 */
function spawnVisibleAgents(): void {
  agentStore.reset();
  if (residentialIdx.length === 0 || workIdx.length === 0) return;

  const homeWeights = buildWeights(residentialIdx, (i) => buildingStore.population[i] || 1);
  const workWeights = buildWeights(workIdx, (i) => buildingStore.capacity[i]);

  // R2：目标数 = districts × 25，clamp 到 [200, maxVisibleAgents]
  const districtCount = Math.max(1, districtStore.districts.length);
  const target = Math.min(maxVisibleAgents, Math.max(200, districtCount * 25));

  const driverRate = lastMetrics?.driverRate ?? 0.1;

  for (let n = 0; n < target; n++) {
    const home = residentialIdx[weightedPick(homeWeights, randomFn())];
    const work = workIdx[weightedPick(workWeights, randomFn())];
    const hp = buildingEntry(home);
    const wp = buildingEntry(work);
    const jitter = 0.4;
    const hx = hp.x + (randomFn() - 0.5) * jitter;
    const hz = hp.z + (randomFn() - 0.5) * jitter;
    const wxp = wp.x + (randomFn() - 0.5) * jitter;
    const wzp = wp.z + (randomFn() - 0.5) * jitter;

    const isDriver = randomFn() < driverRate;
    const agentKind = isDriver ? AgentKind.Driver : AgentKind.Walker;
    const i = agentStore.spawn(hx, hz, wxp, wzp, agentKind);
    if (i < 0) break;

    // E4：个人化离家/下班时刻（Box-Muller 高斯采样）
    // 离家：均值 7.25h，σ=0.4h，clamp 到 [6.5, 8.0]
    // 下班：均值 17.6h，σ=0.4h，clamp 到 [17.0, 19.0]
    agentStore.leaveHomeHour[i] = clamp(gaussian(randomFn) * 0.4 + 7.25, 6.5, 8.0);
    agentStore.leaveWorkHour[i] = clamp(gaussian(randomFn) * 0.4 + 17.6, 17.0, 19.0);

    const r = randomFn();
    if (r < 0.5) {
      // 上班路上：让 tick 0 自动 dispatch（state 已经是 GoingToWork 触发的前置 = AtHome→Morning）
      // 简化策略：直接给个 GoingToWork，强制 dispatch 一次（force=true，避开限流）
      agentStore.state[i] = AgentState.GoingToWork;
      forceDispatchInitialTrip(i, hx, hz, wxp, wzp);
    } else if (r < 0.8) {
      agentStore.x[i] = wxp;
      agentStore.z[i] = wzp;
      agentStore.state[i] = AgentState.Working;
    }
    // 其余 20% AtHome（默认）
  }
}

/**
 * 渐进补人：不 reset、不替换、只往上补差。
 *
 * 迭代 3 R2：目标数与 spawnVisibleAgents 同步，按 district 数推导。
 * 街区生灭后这里会自然跟随：街区多了 → 装饰代理多了；街区少了 → 不会立刻 kill，
 * 但下一次 reset 时回归基线。
 */
function topUpAgents(): void {
  if (residentialIdx.length === 0 || workIdx.length === 0) return;
  const districtCount = Math.max(1, districtStore.districts.length);
  const target = Math.min(maxVisibleAgents, Math.max(200, districtCount * 25));
  const have = agentStore.count;
  if (have >= target) return;
  const need = target - have;
  const batch = Math.max(1, Math.ceil(need / 4));
  const homeWeights = buildWeights(residentialIdx, (i) => buildingStore.population[i] || 1);
  const workWeights = buildWeights(workIdx, (i) => buildingStore.capacity[i]);
  const driverRate = lastMetrics?.driverRate ?? 0.1;

  for (let k = 0; k < batch; k++) {
    const home = residentialIdx[weightedPick(homeWeights, randomFn())];
    const work = workIdx[weightedPick(workWeights, randomFn())];
    const hp = buildingEntry(home);
    const wp = buildingEntry(work);
    const jitter = 0.4;
    const hx = hp.x + (randomFn() - 0.5) * jitter;
    const hz = hp.z + (randomFn() - 0.5) * jitter;
    const wxp = wp.x + (randomFn() - 0.5) * jitter;
    const wzp = wp.z + (randomFn() - 0.5) * jitter;
    const isDriver = randomFn() < driverRate;
    const agentKind = isDriver ? AgentKind.Driver : AgentKind.Walker;
    const i = agentStore.spawn(hx, hz, wxp, wzp, agentKind);
    if (i < 0) break;
    agentStore.leaveHomeHour[i] = clamp(gaussian(randomFn) * 0.4 + 7.25, 6.5, 8.0);
    agentStore.leaveWorkHour[i] = clamp(gaussian(randomFn) * 0.4 + 17.6, 17.0, 19.0);
    // 默认 AtHome：下一次早高峰自然加入循环；新增不立刻在画面上闪现
  }
}

/** 初始化时强制规划一次 trip，让"上班路上"的代理进入合理的 phase 与 edge。 */
function forceDispatchInitialTrip(i: number, sx: number, sz: number, tx: number, tz: number): void {
  if (!pathContext) return;
  const plan = pathing.planTrip(sx, sz, tx, tz, pathContext, /*force=*/true);
  if (!plan) {
    // 极端情况：没找到路径，留作普通 walk
    return;
  }
  agentStore.setEdgeTrip(i, plan.edges, { x: plan.entryX, z: plan.entryZ }, { x: tx, z: tz });
  agentStore.tripStartTick[i] = 0;
  // 把代理位置散到途中：50% 概率进入 Cruise 段
  if (plan.edges.length > 0 && randomFn() < 0.7) {
    const totalLen = plan.totalLength;
    const targetDist = randomFn() * totalLen * 0.8;        // 0~80%
    let acc = 0;
    let placed = false;
    const g = pathContext.graph;
    for (let k = 0; k < plan.edges.length; k++) {
      const e = g.edges[plan.edges[k]];
      if (acc + e.length >= targetDist) {
        const tt = (targetDist - acc) / Math.max(0.01, e.length);
        agentStore.edgeIdx[i] = k;
        agentStore.tOnEdge[i] = tt;
        agentStore.tripPhase[i] = TripPhase.Cruise;
        // 决定方向：默认 from→to（spike 阶段够用）
        agentStore.edgeDirAtoB[i] = 1;
        // 投影位置
        const aN = g.nodes[e.from];
        const bN = g.nodes[e.to];
        agentStore.x[i] = aN.x + (bN.x - aN.x) * tt;
        agentStore.z[i] = aN.z + (bN.z - aN.z) * tt;
        agentStore.targetX[i] = bN.x;
        agentStore.targetZ[i] = bN.z;
        placed = true;
        break;
      }
      acc += e.length;
    }
    if (!placed) {
      // 落到 entry 上
      agentStore.x[i] = plan.entryX;
      agentStore.z[i] = plan.entryZ;
      agentStore.tripPhase[i] = TripPhase.Cruise;
    }
  } else {
    // 还没上路：放在 home → entry 之间
    const t = randomFn() * 0.6;
    agentStore.x[i] = sx + (plan.entryX - sx) * t;
    agentStore.z[i] = sz + (plan.entryZ - sz) * t;
    agentStore.tripPhase[i] = TripPhase.WalkIn;
    agentStore.targetX[i] = plan.entryX;
    agentStore.targetZ[i] = plan.entryZ;
  }
}

function buildWeights(idx: number[], weightOf: (i: number) => number): Float32Array {
  const out = new Float32Array(idx.length);
  let acc = 0;
  for (let k = 0; k < idx.length; k++) {
    acc += Math.max(0.0001, weightOf(idx[k]));
    out[k] = acc;
  }
  return out;
}

function weightedPick(prefix: Float32Array, r: number): number {
  const total = prefix[prefix.length - 1];
  const target = r * total;
  let lo = 0, hi = prefix.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (prefix[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function runTick(): void {
  if (paused) return;
  const t0 = performance.now();

  // E3：把 commute 信号注入经济
  lastMetrics = stepEconomy(buildingStore, getCommuteSignal());
  taxAccumulated += lastMetrics.taxPerTick;

  // 迭代 3 Phase 2 · C2：产业节点产能曲线推进
  stepChain(chainStore, tickCount);

  // 迭代 3 Phase 2 · C3：货车运输线推进
  if (pathContext) {
    tickProfitAccum.value = 0;
    stepLines(lineStore, {
      agentStore,
      chainStore,
      pathCtx: pathContext,
      tickProfit: tickProfitAccum,
      // 迭代 3 T1：货车在 town 卸货时累加到对应 district
      townSupply: (districtId, res, qty) => {
        districtStore.deliverToDistrict(districtId, res, qty);
      },
    }, tickCount);
    profitPerTick = tickProfitAccum.value;
    profitAccumulated += tickProfitAccum.value;
  }

  // 迭代 3：街区评估 + 生灭决策
  if (districtStore.districts.length > 0) {
    const updates = stepDistricts(districtStore, buildingStore, lastMetrics, tickCount, randomFn);
    for (const u of updates) {
      const dist = districtStore.districts[u.districtId];
      if (u.type === 'spawn' && u.spawnHint) {
        const use = zoneToUse(dist.zone as 0 | 1 | 2);
        const hint = u.spawnHint;
        const idx = buildingStore.spawn(hint.x, hint.z, hint.w, hint.d, hint.h, use, tickCount);
        if (idx >= 0) {
          // 街区登记
          districtStore.assignBuilding(idx, hint.x, hint.z, hint.w, hint.d);
          // 工作 / 居住索引
          if (use === BuildingUse.Residential) residentialIdx.push(idx);
          else workIdx.push(idx);
          // 注入种子人口（住宅）让 economy 能即时反馈
          if (use === BuildingUse.Residential) {
            buildingStore.population[idx] = Math.min(2, buildingStore.capacity[idx]);
            buildingStore.satisfaction[idx] = 0.55;
          }
          // 通知主线程
          pendingBuildingDeltas.spawned.push({
            uid: buildingStore.uid[idx],
            kind: useToKind(use),
            x: hint.x, z: hint.z, w: hint.w, d: hint.d, h: hint.h,
            seed: idx,
            bornTick: tickCount,
          });
        }
      } else if (u.type === 'shrink' && u.buildingIdx !== undefined) {
        const idx = u.buildingIdx;
        const uid = buildingStore.uid[idx];
        const use = buildingStore.use[idx] as BuildingUse;
        // 摘除索引
        const arr = use === BuildingUse.Residential ? residentialIdx : workIdx;
        const ai = arr.indexOf(idx);
        if (ai >= 0) arr.splice(ai, 1);
        districtStore.detachBuilding(idx);
        buildingStore.destroy(idx);
        if (uid > 0) pendingBuildingDeltas.removed.push(uid);
      }
    }
  }

  // 迭代 2 收尾：60-tick 不再"整批重采样换人"（那是最大瞬移源），
  // 改为"按当前目标渐进补人"——只往上补差，已有代理保留循环 home↔work。
  if (RESPAWN_EVERY_N_TICK > 0 && tickCount > 0 && tickCount % RESPAWN_EVERY_N_TICK === 0) {
    topUpAgents();
  }

  if (pathContext) {
    stepTick(agentStore, tickCount, pathContext, recordCommute);
  }

  if (trafficStore) {
    trafficStore.countAgents(agentStore.x, agentStore.z, agentStore.count);

    // E3：当全局拥堵显著抬高时，让缓存按"成本权重变了"方式失效；
    // 30 tick 冷却避免在反馈环里抖动。
    if (tickCount - lastReplanTick >= REPLAN_COOLDOWN_TICK) {
      let maxCong = 0;
      for (const e of trafficStore.graph.edges) {
        if (e.congestion > maxCong) maxCong = e.congestion;
      }
      if (maxCong > 0.6) {
        pathing.invalidate();
        lastReplanTick = tickCount;
      }
    }
  }

  lastTickMs = performance.now() - t0;
  tickCount++;
  postSnapshot();
}

function postSnapshot(): void {
  const buf = pool.acquire();
  const baseSnap = packSnapshot(agentStore, tickCount, tickCount * TICK_MS, buf);

  let city: CityMetricsSnapshot | null = null;
  if (lastMetrics) {
    const hourProgress = (tickCount % TICKS_PER_DAY) / TICKS_PER_DAY;
    const hour = hourProgress * 24;
    city = {
      population: lastMetrics.population,
      jobs: lastMetrics.jobs,
      employed: lastMetrics.employed,
      unemploymentRate: lastMetrics.unemploymentRate,
      housingCapacity: lastMetrics.housingCapacity,
      housingDemandPressure: lastMetrics.housingDemandPressure,
      commercialCapacity: lastMetrics.commercialCapacity,
      commercialCoverage: lastMetrics.commercialCoverage,
      taxPerTick: lastMetrics.taxPerTick,
      taxAccumulated,
      satisfactionAvg: lastMetrics.satisfactionAvg,
      driverRate: lastMetrics.driverRate,
      hour,
      avgCommuteSec: lastMetrics.avgCommuteTicks / TICK_HZ,
      targetCommuteSec: lastMetrics.targetCommuteTicks / TICK_HZ,
    };
  }

  // 迭代 3：街区调试快照（每 tick 推送，但占用很小）
  let districts: DistrictSnapshot[] | undefined;
  if (districtStore.districts.length > 0) {
    districts = districtStore.districts.map((d) => ({
      id: d.id,
      col: d.col,
      row: d.row,
      zone: d.zone as 0 | 1 | 2,
      bx: d.bounds.x,
      bz: d.bounds.z,
      bw: d.bounds.w,
      bd: d.bounds.d,
      buildings: d.buildings.length,
      demand: d.demand,
      supplied: d.supplied,
      fulfillment: d.fulfillment,
    }));
  }

  // 迭代 3：建筑增删差量。本 tick 没变化就不带这个字段。
  const hasDelta =
    pendingBuildingDeltas.spawned.length > 0 ||
    pendingBuildingDeltas.removed.length > 0;
  const buildingDelta = hasDelta
    ? {
        spawned: pendingBuildingDeltas.spawned.slice(),
        removed: pendingBuildingDeltas.removed.slice(),
      }
    : undefined;
  pendingBuildingDeltas.spawned.length = 0;
  pendingBuildingDeltas.removed.length = 0;

  // 迭代 3 Phase 2 · 产业节点快照
  let chain: ChainSnapshotItem[] | undefined;
  if (chainStore.nodes.length > 0) {
    chain = chainStore.nodes.map((node) => {
      const inBuf: Array<{ res: string; qty: number }> = [];
      for (const [r, q] of node.inBuffer) if (q > 0) inBuf.push({ res: r, qty: q });
      const outBuf: Array<{ res: string; qty: number }> = [];
      for (const [r, q] of node.outBuffer) if (q > 0) outBuf.push({ res: r, qty: q });
      return {
        id: node.id as unknown as number,
        producerId: node.producerId as unknown as string,
        buildingIdx: node.buildingIdx,
        level: node.level,
        x: node.x, z: node.z,
        inBuf, outBuf,
        goodTicks: node.goodTicks,
        badTicks: node.badTicks,
      };
    });
  }

  // 迭代 3 Phase 2 · C3 运输线快照
  let lines: LineSnapshotItem[] | undefined;
  if (lineStore.lines.length > 0) {
    lines = lineStore.lines.map((l) => ({
      id: l.id as unknown as number,
      resource: l.resource as unknown as string,
      vehicleId: l.vehicleId,
      fleet: l.agentIdxs.length,
      revenue: l.revenueAccum,
      delivered: l.deliveredAccum,
      aerial: l.aerialDistance,
      dstKind: l.dstKind,
    }));
  }

  const snapshot: SimSnapshot = {
    ...baseSnap,
    city,
    roads: trafficStore ? trafficStore.pack() : null,
    respawned: pendingRespawn,
    buildingDelta,
    districts,
    chain,
    lines,
    profitPerTick,
    profitAccumulated,
  };
  pendingRespawn = false;

  const now = performance.now();
  if (now - lastRateAt >= 1000) {
    ticksPerSec = (tickCount - lastRateTicks) * 1000 / (now - lastRateAt);
    lastRateTicks = tickCount;
    lastRateAt = now;
  }

  tickMsRing[tickMsIdx] = lastTickMs;
  tickMsIdx = (tickMsIdx + 1) % tickMsRing.length;
  let sum = 0;
  for (let i = 0; i < tickMsRing.length; i++) sum += tickMsRing[i];
  const avgTickMs = sum / tickMsRing.length;

  const stats: SimStats = {
    lastTickMs,
    avgTickMs,
    ticksPerSec,
    snapshotBytes: buf.byteLength,
  };

  (self as unknown as Worker).postMessage(
    { type: 'snapshot', payload: snapshot, stats },
    [buf],
  );
}

function startLoop(): void {
  if (tickInterval !== null) {
    clearInterval(tickInterval);
    tickInterval = null;
  }
  if (speedMultiplier <= 0) return;     // 0 = 暂停（用 paused 旁路也行）
  const period = TICK_MS / speedMultiplier;
  tickInterval = setInterval(runTick, period);
}

function setSpeed(mult: number): void {
  // 合法值：0 / 1 / 2 / 4。0 等价 pause（兼容 P 行为）
  if (mult !== 0 && mult !== 1 && mult !== 2 && mult !== 4) return;
  speedMultiplier = mult;
  paused = mult === 0;
  startLoop();
}

self.onmessage = (e: MessageEvent<IncomingMsg>) => {
  const msg = e.data;
  switch (msg.type) {
    case 'init': {
      initWorld(msg.config);
      startLoop();
      (self as unknown as Worker).postMessage({ type: 'ready' });
      break;
    }
    case 'reset': {
      initWorld(msg.config);
      tickCount = 0;
      tickMsRing.fill(0);
      tickMsIdx = 0;
      lastTickMs = 0;
      lastRateAt = performance.now();
      lastRateTicks = 0;
      (self as unknown as Worker).postMessage({ type: 'reset-ok' });
      break;
    }
    case 'pause':  paused = true;  if (tickInterval) { clearInterval(tickInterval); tickInterval = null; } break;
    case 'resume': paused = false; startLoop(); break;
    case 'set-speed': setSpeed(msg.multiplier); break;
    case 'return-buffer': {
      pool.release(msg.buffer);
      break;
    }
    case 'boost-road': {
      // E3：玩家"拓路"。把指定父路下所有 edge 的 capacity 乘以 multiplier，
      // 立刻让缓存失效，下一个早高峰会感受到。
      if (trafficStore) {
        const eids = trafficStore.graph.edgesByParent[msg.parentRoadId] || [];
        for (const id of eids) {
          trafficStore.graph.edges[id].capacity *= msg.multiplier;
        }
        pathing.invalidate();
      }
      break;
    }
    case 'add-road': {
      // 迭代 3 R3：玩家铺路。把段加进 TrafficStore，整图重建，缓存清掉。
      if (trafficStore) {
        trafficStore.addPlayerRoad(msg.seg, msg.playerId);
        pathContext = makePathContext(trafficStore);
        pathing.invalidate();
        lineStore.invalidateAllPlans();
        // 通知主线程：路网已变，请刷新 RoadHeatmap region 列表
        (self as unknown as Worker).postMessage({
          type: 'roads-changed',
          regions: trafficStore.regions.map((r) => ({ x: r.x, z: r.z, w: r.w, d: r.d })),
        });
      }
      break;
    }
    case 'remove-road': {
      if (trafficStore) {
        const ok = trafficStore.removePlayerRoad(msg.playerId);
        if (ok) {
          pathContext = makePathContext(trafficStore);
          pathing.invalidate();
          lineStore.invalidateAllPlans();
          (self as unknown as Worker).postMessage({
            type: 'roads-changed',
            regions: trafficStore.regions.map((r) => ({ x: r.x, z: r.z, w: r.w, d: r.d })),
          });
        }
      }
      break;
    }
  }
};

(self as unknown as Worker).postMessage({ type: 'loaded' });

export {};

// 让 gridSize 不被 tree-shake 掉（reset 时 init 用）
void gridSize;
