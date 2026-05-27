/**
 * 运输线（迭代 3 · Phase 2 · C3）
 *
 * 设计来源：design.md §4.5
 *
 * 职责：
 *   - 管理 TransportLine 列表（玩家创建/拆除）
 *   - 每 tick：
 *     a) 给空闲货车派发"去 src 装货"任务
 *     b) 装载时从 src.outBuffer 抽取 capacity 个 resource
 *     c) 卸货时把货放进 dst.inBuffer，并按收入公式结算 revenue
 *     d) 走完一段 trip 自动返程开始下一轮
 *
 * 与现有 sim 的接口：
 *   - 货车 agent 复用 AgentStore（kind=Truck，新增 lineId/cargo/truckPhase/loadTicks 字段）
 *   - 寻路用 pathing.planTrip（与通勤共用一套缓存）
 *   - tick 推进货车位置在本文件 `tickTrucks` 内实现，与 `tick.ts` 的通勤推进分离
 *
 * V0 简化：
 *   - 一条线只运一种 resource（src 必须能出该 resource）
 *   - 不做"返程顺带反向运货"
 *   - 不做"多 src 串站"
 *   - 卸货失败（dst 不收）暂时直接 drop 并赔本（V1 再补"目的地满"逻辑）
 */

import { AgentKind } from '../types';
import { AgentStore } from '../agents';
import type { RoadGraph, RoadEdge } from '../roadGraph';
import { pathing, type PathContext } from '../pathing';
import { ChainStore, type ProducerNode } from './chain';
import { getResource } from './catalog';
import type { ResourceId, LineId, NodeId } from './types';

// === 车型 ==================================================================

export type VehicleId = 'truck-small' | 'truck-large';

export const VEHICLE_CATALOG: Record<VehicleId, {
  name: string;
  capacity: number;        // 每车载货上限
  baseSpeed: number;       // tile/s，对应 RoadGraph 边的 speedFactor
  maintenancePerTick: number;
}> = {
  'truck-small': { name: '小货车', capacity: 8,  baseSpeed: 4.0, maintenancePerTick: 0.04 },
  'truck-large': { name: '大货车', capacity: 16, baseSpeed: 3.2, maintenancePerTick: 0.07 },
};

// === Truck phase 枚举 ======================================================
// 不用 TS const enum 避免和 AgentStore 的 truckPhase: Uint8Array 解码冲突
export const TruckPhase = {
  GoToSrc:   0,    // 空载从 dst 端开往 src
  Loading:   1,    // 在 src 装货（倒计时）
  GoToDst:   2,    // 满载从 src 开往 dst
  Unloading: 3,    // 在 dst 卸货（倒计时）
} as const;

const LOAD_TICKS_DEFAULT   = 4;   // 1 秒装满
const UNLOAD_TICKS_DEFAULT = 4;
/** 同一条 line 内派车的"出发间隔"，避免一波涌出 */
const TRUCK_RELEASE_INTERVAL_TICK = 8;
/** 货车寻路失败的重试冷却（路网变 / 临时阻塞时不至于每 tick 重 planTrip） */
const TRUCK_REPLAN_COOLDOWN = 12;
/** 货车移动用的"自由流速度"（无拥堵时），单位 tile/s。被 V0 简化用，未来按车型 */
const FREEFLOW_SPEED = 4.0;

// === TransportLine =========================================================

export interface TransportLine {
  id: LineId;
  src: NodeId;             // ChainStore 节点 id（src）
  dst: NodeId;             // ChainStore 节点 id 或 TownDistrict node id（后续 T1 接入）
  resource: ResourceId;
  vehicleId: VehicleId;
  /** 车队规模（实际持有的货车 agent 数） */
  fleetSize: number;
  /** 当前活跃货车的 agent idx 列表 */
  agentIdxs: number[];
  /** 最近一次派车的 tick */
  lastReleaseTick: number;
  /** 本生命周期统计 */
  revenueAccum: number;
  deliveredAccum: number;
  /** 派生数据，每次 line 变化或路网变化时刷新 */
  aerialDistance: number;
  /** dst 类型：'producer' 表示 ChainStore 产业节点；'town' 是城市街区 */
  dstKind: 'producer' | 'town';
  /** 仅 dstKind='town' 时使用：街区 id（用于把 supplied 累加到对的 district） */
  dstTownDistrictId?: number;
  /** 起点世界坐标（每次创建时存一份，避免每 tick 重查） */
  srcPos: { x: number; z: number };
  /** 终点世界坐标 */
  dstPos: { x: number; z: number };
  /** 迭代 3 Phase 4：path plan 缓存（src→dst 的 edges 序列）+ entry/exit 路网坐标 */
  fwdPath: PlanCache | null;
  /** 迭代 3 Phase 4：dst→src 反向 plan */
  bwdPath: PlanCache | null;
}

interface PlanCache {
  edges: RoadEdge[];
  entry: { x: number; z: number };
  exit: { x: number; z: number };
  /** plan 失效标记：路网变更后 worker 调 line.invalidatePlans() 清空 */
}

/** 当 dst 是 town 街区时，调用方需要提供"街区 supplied 累加器" */
export interface TownSupplyCallback {
  (districtId: number, res: ResourceId, qty: number): void;
}

// === LineStore =============================================================

export class LineStore {
  readonly lines: TransportLine[] = [];
  private nextId = 0;

  reset(): void {
    this.lines.length = 0;
    this.nextId = 0;
  }

  create(opts: {
    src: NodeId;
    dst: NodeId;
    resource: ResourceId;
    vehicleId: VehicleId;
    fleetSize: number;
    dstKind: 'producer' | 'town';
    dstTownDistrictId?: number;
    srcPos: { x: number; z: number };
    dstPos: { x: number; z: number };
  }): TransportLine {
    const aerial = Math.hypot(opts.srcPos.x - opts.dstPos.x, opts.srcPos.z - opts.dstPos.z);
    const line: TransportLine = {
      id: (this.nextId++) as LineId,
      src: opts.src,
      dst: opts.dst,
      resource: opts.resource,
      vehicleId: opts.vehicleId,
      fleetSize: opts.fleetSize,
      agentIdxs: [],
      lastReleaseTick: -1000,
      revenueAccum: 0,
      deliveredAccum: 0,
      aerialDistance: aerial,
      dstKind: opts.dstKind,
      dstTownDistrictId: opts.dstTownDistrictId,
      srcPos: { ...opts.srcPos },
      dstPos: { ...opts.dstPos },
      fwdPath: null,
      bwdPath: null,
    };
    this.lines.push(line);
    return line;
  }

  /** 迭代 3 Phase 4：路网变化时让所有 line 重新规划路径。 */
  invalidateAllPlans(): void {
    for (const l of this.lines) {
      l.fwdPath = null;
      l.bwdPath = null;
    }
  }

  destroy(id: LineId, agentStore: AgentStore): void {
    const i = this.lines.findIndex((l) => l.id === id);
    if (i < 0) return;
    const line = this.lines[i];
    // 标记车辆"待回收"（让 spawnTrucks 不再使用），位置移到 -1000 避免影响热力图
    for (const ai of line.agentIdxs) {
      agentStore.lineId[ai] = -1;
      agentStore.x[ai] = -1000;
      agentStore.z[ai] = -1000;
    }
    this.lines.splice(i, 1);
  }
}

// === 每 tick 主循环 =========================================================

export interface LinesContext {
  agentStore: AgentStore;
  chainStore: ChainStore;
  pathCtx: PathContext;
  /** dst 是 town 时的回调；不传则 town 卸货失败 */
  townSupply?: TownSupplyCallback;
  /** 本 tick 累计利润（供 HUD 显示） */
  tickProfit: { value: number };
}

/**
 * 推进一 tick 所有线。
 *
 * 主要事件：
 *   1) 维护 fleetSize → 缺人就 spawn
 *   2) 推进每辆货车的位置（按 phase）
 *   3) 装/卸货 phase 倒计时到 0 → 切 phase
 *   4) 结算 revenue / 扣 maintenance
 */
export function stepLines(store: LineStore, ctx: LinesContext, tick: number): void {
  const { agentStore, chainStore, pathCtx } = ctx;

  for (const line of store.lines) {
    const src = findNode(chainStore, line.src);
    if (!src) continue;
    // 直接读 line.dstPos（创建时存）
    const dstPos = line.dstPos;
    void chainStore;       // 让 eslint 不抱怨 unused

    // === 1) 车队管理 ====================================================
    // 把已不在 lineId 上的 agent 摘掉（destroy 时已经清，但 safer 再扫一遍）
    line.agentIdxs = line.agentIdxs.filter((ai) => agentStore.lineId[ai] === line.id);

    // 缺人时按节奏 spawn（每 RELEASE_INTERVAL 一辆）
    if (line.agentIdxs.length < line.fleetSize &&
        tick - line.lastReleaseTick >= TRUCK_RELEASE_INTERVAL_TICK) {
      const newIdx = spawnTruck(agentStore, line, src.x, src.z);
      if (newIdx >= 0) {
        line.agentIdxs.push(newIdx);
        line.lastReleaseTick = tick;
      }
    }

    // === 2) 每辆货车推进 =================================================
    for (const ai of line.agentIdxs) {
      stepTruck(ai, line, src, dstPos, ctx, tick);
    }

    // === 3) 维护费 =======================================================
    const vh = VEHICLE_CATALOG[line.vehicleId];
    const cost = vh.maintenancePerTick * line.agentIdxs.length;
    ctx.tickProfit.value -= cost;
    line.revenueAccum -= cost;
  }
}

/** 找 chain 节点（src 永远是 producer）。 */
function findNode(chainStore: ChainStore, id: NodeId): ProducerNode | null {
  for (const n of chainStore.nodes) if (n.id === id) return n;
  return null;
}

// getDstPos 已删除：line.dstPos 在 create 时存好

/** spawn 一辆货车 agent，初始 phase=GoToSrc，位置放在 src 旁。 */
function spawnTruck(agentStore: AgentStore, line: TransportLine, sx: number, sz: number): number {
  const i = agentStore.spawn(sx, sz, sx, sz, AgentKind.Truck);
  if (i < 0) return -1;
  agentStore.lineId[i] = line.id;
  agentStore.truckPhase[i] = TruckPhase.GoToSrc;
  agentStore.cargo[i] = 0;
  agentStore.loadTicks[i] = 0;
  // 起步位置：稍偏离 src 中心，避免重叠
  agentStore.x[i] = sx + ((i * 31) % 7) * 0.15 - 0.5;
  agentStore.z[i] = sz + ((i * 17) % 7) * 0.15 - 0.5;
  return i;
}

/** 单辆货车 phase 推进。 */
function stepTruck(
  ai: number,
  line: TransportLine,
  src: ProducerNode,
  dstPos: { x: number; z: number },
  ctx: LinesContext,
  tick: number,
): void {
  const { agentStore, chainStore } = ctx;
  const phase = agentStore.truckPhase[ai];

  switch (phase) {
    case TruckPhase.GoToSrc: {
      // 朝 src 方向走（按 bwdPath：dst→src）
      const plan = ensurePlan(line, dstPos, { x: src.x, z: src.z }, ctx, false);
      if (driveAlongPlan(ai, plan, { x: src.x, z: src.z }, ctx)) {
        agentStore.truckPhase[ai] = TruckPhase.Loading;
        agentStore.loadTicks[ai] = LOAD_TICKS_DEFAULT;
        // 清掉 edge 状态
        agentStore.edgeCount[ai] = 0;
      }
      break;
    }
    case TruckPhase.Loading: {
      if (agentStore.loadTicks[ai] > 0) {
        agentStore.loadTicks[ai]--;
        break;
      }
      const vh = VEHICLE_CATALOG[line.vehicleId];
      const taken = chainStore.takeFromOut(src, line.resource, vh.capacity);
      agentStore.cargo[ai] = taken;
      agentStore.truckPhase[ai] = TruckPhase.GoToDst;
      // 重置：进入新 phase 前清 edge 序列
      agentStore.edgeCount[ai] = 0;
      break;
    }
    case TruckPhase.GoToDst: {
      const plan = ensurePlan(line, { x: src.x, z: src.z }, dstPos, ctx, true);
      if (driveAlongPlan(ai, plan, dstPos, ctx)) {
        agentStore.truckPhase[ai] = TruckPhase.Unloading;
        agentStore.loadTicks[ai] = UNLOAD_TICKS_DEFAULT;
        agentStore.edgeCount[ai] = 0;
      }
      break;
    }
    case TruckPhase.Unloading: {
      if (agentStore.loadTicks[ai] > 0) {
        agentStore.loadTicks[ai]--;
        break;
      }
      const delivered = agentStore.cargo[ai];
      if (delivered > 0) {
        if (line.dstKind === 'producer') {
          const dstNode = findNode(chainStore, line.dst);
          if (dstNode) chainStore.putToIn(dstNode, line.resource, delivered);
        } else if (line.dstKind === 'town' && line.dstTownDistrictId !== undefined && ctx.townSupply) {
          ctx.townSupply(line.dstTownDistrictId, line.resource, delivered);
        }
        const baseRate = getResource(line.resource).baseRate;
        const rev = baseRate * line.aerialDistance * 1.0 * delivered;
        line.revenueAccum += rev;
        line.deliveredAccum += delivered;
        ctx.tickProfit.value += rev;
      }
      agentStore.cargo[ai] = 0;
      agentStore.truckPhase[ai] = TruckPhase.GoToSrc;
      agentStore.edgeCount[ai] = 0;
      break;
    }
  }
  void tick;
}

/**
 * 确保 line 已规划好对应方向的路径（缓存）。
 * @param forward true = src→dst 用 fwdPath；false = dst→src 用 bwdPath
 */
function ensurePlan(
  line: TransportLine,
  from: { x: number; z: number },
  to: { x: number; z: number },
  ctx: LinesContext,
  forward: boolean,
): PlanCache | null {
  const cached = forward ? line.fwdPath : line.bwdPath;
  if (cached) return cached;
  const plan = pathing.planTrip(from.x, from.z, to.x, to.z, ctx.pathCtx, true);
  if (!plan) return null;
  // pathing.planTrip 返回的是 edge id 数组；这里把它解到 RoadEdge[] 引用
  const graph = ctx.pathCtx.graph;
  const edges: RoadEdge[] = plan.edges.map((id) => graph.edges[id]);
  const out: PlanCache = {
    edges,
    entry: { x: plan.entryX, z: plan.entryZ },
    exit: { x: plan.exitX, z: plan.exitZ },
  };
  if (forward) line.fwdPath = out;
  else line.bwdPath = out;
  return out;
}

/**
 * 沿 plan 推进货车一次 tick。
 *
 * 走法（简化）：
 *   1) 若货车的 edgeCount 是 0，初始化：edge 数组复用 AgentStore.edgeSeq；
 *      先朝 plan.entry 走（一次性瞬移到 entry 也可，但视觉跳跃；这里直接挪过去）
 *   2) 在 edge 上沿 (from→to) 推进 tOnEdge；到 1 切下一条 edge
 *   3) 所有 edge 走完后，从 exit 朝 target 直线走（最后一段 walkOut）
 *   4) 距离 target < 0.4 视为到达，返回 true
 *
 * 速度：FREEFLOW_SPEED × (1 / 4)（4Hz tick）= 每 tick 1 tile
 *       受 edge.congestion 减速：speed × (1 - 0.6 × cong)
 */
function driveAlongPlan(
  ai: number,
  plan: PlanCache | null,
  target: { x: number; z: number },
  ctx: LinesContext,
): boolean {
  const { agentStore } = ctx;

  // 没有 plan（路网未规划/不连通）：兜底直线
  if (!plan || plan.edges.length === 0) {
    return driveLine(ai, target.x, target.z, ctx, 1.0);
  }

  // 初始化：把当前 edge 进度从 0 开始
  if (agentStore.edgeCount[ai] === 0) {
    agentStore.edgeIdx[ai] = 0;
    agentStore.tOnEdge[ai] = 0;
    agentStore.edgeCount[ai] = Math.min(plan.edges.length, 8);
    // 第一步：先把车"瞬移"到 entry（避免从产业建筑中心 → entry 这段直线穿建筑）
    agentStore.x[ai] = plan.entry.x;
    agentStore.z[ai] = plan.entry.z;
    // 决定方向：第一条 edge 的 from 节点更接近 entry，方向 from→to
    const e0 = plan.edges[0];
    const graph = ctx.pathCtx.graph;
    const fn = graph.nodes[e0.from];
    const tn = graph.nodes[e0.to];
    const df = (fn.x - plan.entry.x) ** 2 + (fn.z - plan.entry.z) ** 2;
    const dt = (tn.x - plan.entry.x) ** 2 + (tn.z - plan.entry.z) ** 2;
    agentStore.edgeDirAtoB[ai] = df <= dt ? 1 : 0;
  }

  const idx = agentStore.edgeIdx[ai];
  if (idx >= plan.edges.length) {
    // 走完所有 edge，直线走到 target
    return driveLine(ai, target.x, target.z, ctx, 1.0);
  }

  const e = plan.edges[idx];
  const graph = ctx.pathCtx.graph;
  const fn = graph.nodes[e.from];
  const tn = graph.nodes[e.to];
  const dirAtoB = agentStore.edgeDirAtoB[ai] === 1;
  const startN = dirAtoB ? fn : tn;
  const endN = dirAtoB ? tn : fn;

  // 速度（受拥堵影响）
  const speedMul = 1 - 0.6 * (e.congestion || 0);
  const dx = endN.x - startN.x;
  const dz = endN.z - startN.z;
  const len = Math.max(0.01, Math.hypot(dx, dz));
  // 4Hz tick：每 tick 推进的"沿 edge 比例"
  const dtPerTick = (FREEFLOW_SPEED * 0.25 * speedMul) / len;
  agentStore.tOnEdge[ai] += dtPerTick;

  if (agentStore.tOnEdge[ai] >= 1) {
    // 进入下一条 edge
    agentStore.tOnEdge[ai] = 0;
    agentStore.edgeIdx[ai]++;
    if (agentStore.edgeIdx[ai] < plan.edges.length) {
      // 推断下一条 edge 的方向
      const nextE = plan.edges[agentStore.edgeIdx[ai]];
      // 当前 endN 与 nextE 共节点
      if (nextE.from === (dirAtoB ? e.to : e.from)) {
        agentStore.edgeDirAtoB[ai] = 1;
      } else {
        agentStore.edgeDirAtoB[ai] = 0;
      }
      // 更新位置到上一段终点
      agentStore.x[ai] = endN.x;
      agentStore.z[ai] = endN.z;
    } else {
      // 全部 edge 走完：放到 exit 位置
      agentStore.x[ai] = plan.exit.x;
      agentStore.z[ai] = plan.exit.z;
    }
    return false;
  }

  // 沿 edge 内插
  const t = agentStore.tOnEdge[ai];
  agentStore.x[ai] = startN.x + dx * t;
  agentStore.z[ai] = startN.z + dz * t;
  return false;
}

/** 兜底直线走（无 plan 时使用）。speedMul 可调减速。 */
function driveLine(
  ai: number,
  tx: number, tz: number,
  ctx: LinesContext,
  speedMul: number,
): boolean {
  const { agentStore } = ctx;
  const dx = tx - agentStore.x[ai];
  const dz = tz - agentStore.z[ai];
  const dist = Math.hypot(dx, dz);
  if (dist < 0.4) return true;
  const v = FREEFLOW_SPEED * 0.25 * speedMul;
  const step = Math.min(v, dist);
  agentStore.x[ai] += (dx / dist) * step;
  agentStore.z[ai] += (dz / dist) * step;
  return false;
}

// 让 RoadGraph 字面在依赖里不被 tree-shake
void (null as unknown as RoadGraph);
