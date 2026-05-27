/**
 * 路径规划（E2 · 基于 RoadGraph 的 Dijkstra + 缓存）
 *
 * 设计要点：
 *   - planTrip(srcX, srcZ, dstX, dstZ, ctx) → TripPlan
 *       - entry: home 最近的 RoadNode 坐标（车辆"上路点"）
 *       - exit:  work 最近的 RoadNode 坐标（车辆"下路点"）
 *       - edges: entry → exit 的 RoadEdge id 序列（按 time+comfort 成本最短）
 *   - 路径缓存 key = (entryNodeId, exitNodeId)；图拓扑变就 invalidate（外部调 invalidate()）
 *   - 同 OD 复用：同一对 home/work 的多个代理共享一份 plan
 *   - 寻路队列限频：每帧最多 N 个新请求，超出排到下一帧
 *
 * 与 C3 旧 planPath 的区别：
 *   - 不再返回扁平航点数组；改为 TripPlan 结构
 *   - 不再做"靠右车道偏移"——E2 视觉先回到"沿 edge 中线"，等 E3 再补
 *   - 兼容外层调用：导出 LaneMode 占位（暂时无用）
 */

import { RoadGraph, type EdgeCostFn, makeTimeCost } from './roadGraph';

export interface PathContext {
  /** 路网图。 */
  graph: RoadGraph;
  /** 兼容字段（C3 旧代码引用），E2 之后逐步弃用。 */
  nsRoadCenters: number[];
  ewRoadCenters: number[];
}

export const enum LaneMode {
  Driver = 0,
  Walker = 1,
}

export interface TripPlan {
  entryX: number;
  entryZ: number;
  exitX: number;
  exitZ: number;
  /** edge id 序列；空数组 = 起终点共享同一最近 node，无需上路。 */
  edges: number[];
  /** Dijkstra 估算的成本（time + comfort），tick 用来做"路径成本超阈值"重规划判断。 */
  cost: number;
  /** 估算的"自由流通勤"长度（用于 E3 起步）。 */
  totalLength: number;
}

/** Pathing 系统：包含缓存与限流。 */
export class PathingSystem {
  private cache = new Map<number, TripPlan>();
  private costFn: EdgeCostFn = makeTimeCost(0.5);
  /** 缓存使能开关（debug：关掉证明缓存仅是优化）。 */
  private cacheEnabled = true;
  /** 每 tick 允许新规划的最大次数（限流）。 */
  private maxPlansPerTick = 64;
  private plansThisTick = 0;
  /** 失败查询计数（debug 用）。 */
  hitCount = 0;
  missCount = 0;
  rejectCount = 0;

  setCostFn(fn: EdgeCostFn): void { this.costFn = fn; this.invalidate(); }
  setCacheEnabled(v: boolean): void { this.cacheEnabled = v; if (!v) this.cache.clear(); }
  setMaxPlansPerTick(n: number): void { this.maxPlansPerTick = n; }

  /** 帧开始时调一次。 */
  beginTick(): void { this.plansThisTick = 0; }

  /** 拓扑或成本权重显著变化时（E3 拥堵刷新）调用。 */
  invalidate(): void { this.cache.clear(); }

  /** 缓存键：低位 entryNodeId、高位 exitNodeId（spike 阶段 12 nodes，安全）。 */
  private cacheKey(entry: number, exit: number): number {
    return (exit << 16) | (entry & 0xFFFF);
  }

  /**
   * 规划一次 trip。返回 null 表示被限流（调用方应保留旧路径下一帧再来）。
   * @param force 跳过限流（用于"必须立刻有路"的初始化）
   */
  planTrip(srcX: number, srcZ: number, dstX: number, dstZ: number, ctx: PathContext, force = false): TripPlan | null {
    const g = ctx.graph;
    const entryNode = g.nearestNode(srcX, srcZ);
    const exitNode = g.nearestNode(dstX, dstZ);

    // 起终点同一最近 node：直接走 walk 段（边数 0）
    if (entryNode.id === exitNode.id) {
      return {
        entryX: entryNode.x, entryZ: entryNode.z,
        exitX: exitNode.x, exitZ: exitNode.z,
        edges: [],
        cost: 0,
        totalLength: 0,
      };
    }

    if (this.cacheEnabled) {
      const k = this.cacheKey(entryNode.id, exitNode.id);
      const cached = this.cache.get(k);
      if (cached) { this.hitCount++; return cached; }
    }
    this.missCount++;

    // 限流：超额时返回 null（调用方决定如何 fallback）
    if (!force && this.plansThisTick >= this.maxPlansPerTick) {
      this.rejectCount++;
      return null;
    }
    this.plansThisTick++;

    const path = g.fastestPath(entryNode.id, exitNode.id, this.costFn);
    if (!path) return null;

    let cost = 0;
    let len = 0;
    let prev = null as null | (typeof path)[number];
    const ids: number[] = [];
    for (const e of path) {
      cost += this.costFn(e, prev);
      len += e.length;
      ids.push(e.id);
      prev = e;
    }
    const plan: TripPlan = {
      entryX: entryNode.x, entryZ: entryNode.z,
      exitX: exitNode.x, exitZ: exitNode.z,
      edges: ids,
      cost,
      totalLength: len,
    };
    if (this.cacheEnabled) {
      this.cache.set(this.cacheKey(entryNode.id, exitNode.id), plan);
    }
    return plan;
  }

  /** 给 E3 用：当某 OD 的现成路径成本飙升时强制 invalidate 这一对。 */
  invalidatePair(entryNodeId: number, exitNodeId: number): void {
    this.cache.delete(this.cacheKey(entryNodeId, exitNodeId));
  }
}

/** 单例（worker 内独占）。 */
export const pathing = new PathingSystem();
