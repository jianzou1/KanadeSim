/**
 * 模拟 Worker 主循环（C2 · 加入经济模型）
 *
 * 协议（main ↔ worker）：
 *   main → worker:
 *     { type: 'init',  config: { gridSize, seed, buildings, maxVisibleAgents } }
 *     { type: 'reset', config: { gridSize, seed, buildings, maxVisibleAgents } }
 *     { type: 'pause' } / { type: 'resume' }
 *     { type: 'return-buffer', buffer: ArrayBuffer }
 *
 *   worker → main:
 *     { type: 'loaded' }
 *     { type: 'ready' }
 *     { type: 'snapshot', payload: SimSnapshot, stats: SimStats }
 *     { type: 'reset-ok' }
 *
 * 与 B1 的差异：
 *  - 建筑列表通过 init/reset 同步进来
 *  - 每 tick 先跑 stepEconomy → 再跑 stepTick（代理移动）
 *  - 代理从总人口中采样：可见代理数 = min(maxVisibleAgents, 总人口的某个比例)
 *  - 快照新增 city 字段
 */

import { AgentStore } from './agents';
import { BuildingStore, kindToUse, BuildingUse } from './buildings';
import { stepEconomy, seedInitialPopulation, type CityMetrics } from './economy';
import { packSnapshot, SnapshotPool } from './snapshot';
import { stepTick } from './tick';
import { TrafficStore, type RoadRegion } from './traffic';
import { planPath, type PathContext } from './pathing';
import { AgentState, AgentKind } from './types';
import {
  GRID_SIZE as DEFAULT_GRID,
  TICK_MS,
  TICKS_PER_DAY,
  type CityMetricsSnapshot,
  type SimSnapshot,
  type SimStats,
} from './types';
import type { BuildingSpec } from '../render/buildingInstances';

// === 消息协议 ===============================================================

interface SimConfig {
  gridSize: number;
  seed: number;
  buildings: BuildingSpec[];
  maxVisibleAgents: number;
  roads: RoadRegion[];
}

interface InitMsg  { type: 'init';  config: SimConfig }
interface ResetMsg { type: 'reset'; config: SimConfig }
interface PauseMsg  { type: 'pause' }
interface ResumeMsg { type: 'resume' }
interface ReturnBufferMsg { type: 'return-buffer'; buffer: ArrayBuffer }

type IncomingMsg = InitMsg | ResetMsg | PauseMsg | ResumeMsg | ReturnBufferMsg;

// === Worker 状态 ============================================================

const agentStore = new AgentStore();
const buildingStore = new BuildingStore();
const pool = new SnapshotPool();
let trafficStore: TrafficStore | null = null;
let pathContext: PathContext = { nsRoadCenters: [], ewRoadCenters: [] };
let randomFn: () => number = Math.random;

let tickInterval: ReturnType<typeof setInterval> | null = null;
let tickCount = 0;
let paused = false;
let maxVisibleAgents = 1000;
let gridSize = DEFAULT_GRID;
let taxAccumulated = 0;
let lastMetrics: CityMetrics | null = null;

// C3 · 每 N tick 按当前人口/岗位加权重新采样代理来源（模拟"通勤需求随城市变化"）
const RESPAWN_EVERY_N_TICK = 60;

// 索引：住宅 / 工作建筑（用于代理采样和分配）
let residentialIdx: number[] = [];
let workIdx: number[] = [];

// 统计
const tickMsRing = new Float32Array(60);
let tickMsIdx = 0;
let lastTickMs = 0;
let lastRateAt = performance.now();
let lastRateTicks = 0;
let ticksPerSec = 0;

// C3.3 · 重采样标记：本帧 spawnVisibleAgents 后下一份快照需要告知主线程跳过插值
let pendingRespawn = false;

// === 工具 ===================================================================

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

/** 取建筑入口（B1 用建筑中心，C3 改用最近道路点）。 */
function buildingEntry(i: number): { x: number; z: number } {
  return {
    x: buildingStore.x[i] + buildingStore.w[i] / 2,
    z: buildingStore.z[i] + buildingStore.d[i] / 2,
  };
}

/**
 * 从矩形路段列表反推 NS/EW 道路中心。
 *   南北路：w 小（窄）、d 大（长跨整张地图），中心 x = x + w/2
 *   东西路：w 大、d 小，中心 z = z + d/2
 */
function buildPathContext(roads: RoadRegion[]): PathContext {
  const ns: number[] = [];
  const ew: number[] = [];
  for (const r of roads) {
    if (r.d >= r.w) {
      // 南北路（纵向长）
      ns.push(r.x + r.w / 2);
    } else {
      // 东西路（横向长）
      ew.push(r.z + r.d / 2);
    }
  }
  return { nsRoadCenters: ns, ewRoadCenters: ew };
}

// === 初始化 =================================================================

function initWorld(cfg: SimConfig): void {
  agentStore.reset();
  buildingStore.reset();
  taxAccumulated = 0;
  residentialIdx = [];
  workIdx = [];
  gridSize = cfg.gridSize;
  maxVisibleAgents = cfg.maxVisibleAgents;
  trafficStore = new TrafficStore(cfg.roads);
  randomFn = mulberry32(cfg.seed);

  // 构建路径上下文：从矩形 region 提取 NS/EW 路的中心坐标
  pathContext = buildPathContext(cfg.roads);

  // 1. 把建筑灌进 BuildingStore
  for (const b of cfg.buildings) {
    const use = kindToUse(b.kind);
    const idx = buildingStore.spawn(b.x, b.z, b.w, b.d, b.h, use);
    if (idx < 0) break;
    if (use === BuildingUse.Residential) residentialIdx.push(idx);
    else workIdx.push(idx);
  }

  // 2. 撒一批种子人口，让经济启动
  seedInitialPopulation(buildingStore, 4);

  // 3. 生成可见代理：从住宅采样一些"通勤代表"
  spawnVisibleAgents();
  pendingRespawn = true;     // 初始化也算一次重生
}

/**
 * 从城市当前人口里采样若干"代表性代理"作为可见小方块。
 * C3 改进：按"住宅当前人口"加权采 home，按"工作建筑岗位"加权采 work。
 * 这样高人口的住宅自然派出更多代理，热门工业区自然吸引更多人涌入。
 */
function spawnVisibleAgents(): void {
  agentStore.reset();
  if (residentialIdx.length === 0 || workIdx.length === 0) return;

  // 构建加权采样表
  const homeWeights = buildWeights(residentialIdx, (i) => buildingStore.population[i] || 1);
  const workWeights = buildWeights(workIdx, (i) => buildingStore.capacity[i]);

  // 总人口决定可见代理数（带上限）
  const totalPop = lastMetrics?.population ?? 0;
  // 居民越多 → 可见越多，但有上限。C2 启动初期还没人口，就用 maxVisibleAgents 的一半作下限
  const target = Math.min(
    maxVisibleAgents,
    Math.max(Math.floor(maxVisibleAgents * 0.5), Math.floor(totalPop * 0.15)),
  );

  const driverRate = lastMetrics?.driverRate ?? 0.1;

  for (let n = 0; n < target; n++) {
    const home = residentialIdx[weightedPick(homeWeights, randomFn())];
    const work = workIdx[weightedPick(workWeights, randomFn())];
    const hp = buildingEntry(home);
    const wp = buildingEntry(work);
    // 给同一建筑出发的代理一点位置抖动，避免在地图上叠成一柱
    const jitter = 0.4;
    const hx = hp.x + (randomFn() - 0.5) * jitter;
    const hz = hp.z + (randomFn() - 0.5) * jitter;
    const wxp = wp.x + (randomFn() - 0.5) * jitter;
    const wzp = wp.z + (randomFn() - 0.5) * jitter;

    // C3.2 决定 walker / driver
    const isDriver = randomFn() < driverRate;
    const agentKind = isDriver ? AgentKind.Driver : AgentKind.Walker;
    const i = agentStore.spawn(hx, hz, wxp, wzp, agentKind);
    if (i < 0) break;

    // 立刻派发：让代理"分散在通勤路途上"，画面立刻有人流而不是全在家
    // 50% 上班路上，30% 在公司，20% 在家
    const r = randomFn();
    if (r < 0.5) {
      // 在上班路上：用 planPath 生成航点，把代理直接放到中间航点附近
      const side = isDriver ? 0 : 0.7;
      const pts = planPath(hx, hz, wxp, wzp, pathContext, side);
      const idxOn = 1 + ((randomFn() * 2) | 0);   // 1..2
      agentStore.setWaypoints(i, pts);
      agentStore.wpIdx[i] = idxOn;
      const wpAt = agentStore.getWaypoint(i, idxOn);
      agentStore.x[i] = wpAt.x + (randomFn() - 0.5) * 0.5;
      agentStore.z[i] = wpAt.z + (randomFn() - 0.5) * 0.5;
      agentStore.targetX[i] = wpAt.x;
      agentStore.targetZ[i] = wpAt.z;
      agentStore.state[i] = AgentState.GoingToWork;
    } else if (r < 0.8) {
      // 在公司：直接放公司位置
      agentStore.x[i] = wxp;
      agentStore.z[i] = wzp;
      agentStore.state[i] = AgentState.Working;
    }
    // 其余 20% 默认 AtHome
  }
}

/** 构建累计权重数组（前缀和），用于 O(log n) 加权采样。 */
function buildWeights(idx: number[], weightOf: (i: number) => number): Float32Array {
  const out = new Float32Array(idx.length);
  let acc = 0;
  for (let k = 0; k < idx.length; k++) {
    acc += Math.max(0.0001, weightOf(idx[k]));
    out[k] = acc;
  }
  return out;
}

/** 二分查找加权采样：r ∈ [0, 1)，返回索引 in idx. */
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

// === 单 tick ================================================================

function runTick(): void {
  if (paused) return;
  const t0 = performance.now();

  // 1) 经济推进（建筑级，每 tick 一次）
  lastMetrics = stepEconomy(buildingStore);
  taxAccumulated += lastMetrics.taxPerTick;

  // 2) 周期性按当前人口/岗位加权重采样可见代理
  if (tickCount > 0 && tickCount % RESPAWN_EVERY_N_TICK === 0) {
    spawnVisibleAgents();
    pendingRespawn = true;     // 标记下一份快照
  }

  // 3) 代理移动（沿航点 + 拥堵衰减，C3.2）
  stepTick(agentStore, tickCount, pathContext, trafficStore);

  // 4) 道路流量统计（C3）
  if (trafficStore) {
    trafficStore.countAgents(agentStore.x, agentStore.z, agentStore.count);
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
    // 当前模拟时刻（24h 制 0-23.999...）
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
    };
  }

  const snapshot: SimSnapshot = {
    ...baseSnap,
    city,
    roads: trafficStore ? trafficStore.pack() : null,
    respawned: pendingRespawn,
  };
  pendingRespawn = false;     // 一次性标志

  // 频率统计
  const now = performance.now();
  if (now - lastRateAt >= 1000) {
    ticksPerSec = (tickCount - lastRateTicks) * 1000 / (now - lastRateAt);
    lastRateTicks = tickCount;
    lastRateAt = now;
  }

  // 滑动平均
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
  if (tickInterval !== null) return;
  tickInterval = setInterval(runTick, TICK_MS);
}

// === 消息分发 ===============================================================

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
    case 'pause':  paused = true;  break;
    case 'resume': paused = false; break;
    case 'return-buffer': {
      pool.release(msg.buffer);
      break;
    }
  }
};

(self as unknown as Worker).postMessage({ type: 'loaded' });

export {};
