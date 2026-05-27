/**
 * 代理存储（SoA 布局 · E2 升级到 edge-based 路径）
 *
 * SoA 红线（design.md §12）：每字段独立 TypedArray，避免十万级对象 GC。
 *
 * E2 改动：
 *   - 引入 edgeSeq / edgeIdx / tOnEdge / edgeCount 三件套，代理"在 edge 上的位置"
 *   - 保留 waypoints / wpIdx / wpCount 作为"上路前 home→入口 / 下路后 出口→work"的兜底
 *   - 三段式 trip：
 *       phase 0: walk home → entry point（最近 edge 端点附近）
 *       phase 1: cruise along edgeSeq[edgeIdx], tOnEdge ∈ [0,1]
 *       phase 2: walk exit point → work
 *   - 一个简单状态机字段 tripPhase（0/1/2），由 tick 推进
 */

import { AgentState, MAX_AGENTS } from './types';

const MAX_WAYPOINTS = 5;
/** 一次 trip 最多的 edge 数（井字图里最多 4 段，留 8 个余量给后续更复杂图）。 */
const MAX_EDGES_PER_TRIP = 8;

/** Trip 内三段：进路、巡航、下路。 */
export const enum TripPhase {
  WalkIn = 0,    // home → entry waypoint
  Cruise = 1,    // 沿 edgeSeq 推进
  WalkOut = 2,   // exit waypoint → work
}

export class AgentStore {
  // 位置（tile 单位）
  readonly x = new Float32Array(MAX_AGENTS);
  readonly z = new Float32Array(MAX_AGENTS);

  // 速度
  readonly vx = new Float32Array(MAX_AGENTS);
  readonly vz = new Float32Array(MAX_AGENTS);

  // 当前的"目标点"（WalkIn/WalkOut 阶段直接朝它走）
  readonly targetX = new Float32Array(MAX_AGENTS);
  readonly targetZ = new Float32Array(MAX_AGENTS);

  readonly state = new Uint8Array(MAX_AGENTS);
  readonly kind = new Uint8Array(MAX_AGENTS);

  readonly homeX = new Float32Array(MAX_AGENTS);
  readonly homeZ = new Float32Array(MAX_AGENTS);
  readonly workX = new Float32Array(MAX_AGENTS);
  readonly workZ = new Float32Array(MAX_AGENTS);

  // === 兜底航点（WalkIn/WalkOut 用）====================================
  /** [wp0X,wp0Z, ..., wp4X,wp4Z]，但 E2 里只用前两个（entry 与 exit）。 */
  readonly waypoints = new Float32Array(MAX_AGENTS * MAX_WAYPOINTS * 2);
  readonly wpIdx = new Uint8Array(MAX_AGENTS);
  readonly wpCount = new Uint8Array(MAX_AGENTS);

  // === Edge 序列（Cruise 阶段用，E2 新增）=============================
  /** 每代理一段 edgeIds（int16 足够，spike 阶段最多 12 条边）。 */
  readonly edgeSeq = new Int16Array(MAX_AGENTS * MAX_EDGES_PER_TRIP);
  /** 当前在第几条 edge（0 起）。 */
  readonly edgeIdx = new Uint8Array(MAX_AGENTS);
  /** 该 trip 总共有几条 edge。 */
  readonly edgeCount = new Uint8Array(MAX_AGENTS);
  /**
   * 当前 edge 上的进度 [0, 1]。0 = 在 from 端，1 = 在 to 端。
   * 注意：edge 是无向的，方向由"上一个 node id"决定，存进 edgeDirAtoB（1 = from→to, 0 = to→from）。
   */
  readonly tOnEdge = new Float32Array(MAX_AGENTS);
  /** 当前 edge 的行进方向：1 表示从 from 走向 to；0 表示反向。 */
  readonly edgeDirAtoB = new Uint8Array(MAX_AGENTS);

  /** Trip 三段相位（仅在 GoingToWork / GoingHome 时有效）。 */
  readonly tripPhase = new Uint8Array(MAX_AGENTS);

  /**
   * 上一次重规划的 tick（E3 用：限频重规划，避免每 tick 都跑 Dijkstra）。
   */
  readonly lastReplanTick = new Int32Array(MAX_AGENTS);

  /**
   * 该 trip 的开始 tick（E3 用：到达后用 (now - tripStart) 计算 commute time，反馈到满意度）。
   */
  readonly tripStartTick = new Int32Array(MAX_AGENTS);

  /**
   * E4：个人离家时刻（小时，0-24，高斯采样在 6.5-8.0 范围）。
   * 早高峰阶段每个代理只在 hour ≥ leaveHomeHour 后出门。
   */
  readonly leaveHomeHour = new Float32Array(MAX_AGENTS);

  /**
   * E4：个人下班时刻（小时，0-24，高斯采样在 17.0-19.0 范围）。
   */
  readonly leaveWorkHour = new Float32Array(MAX_AGENTS);

  // === 迭代 3 C3 · 货车专用字段 ========================================
  /** 货车所属 line id（仅 truck 用），-1 = 非货车。 */
  readonly lineId = new Int32Array(MAX_AGENTS);
  /** 货车 phase（仅 truck 用）：0=空载去 src, 1=src 装货, 2=满载去 dst, 3=dst 卸货 */
  readonly truckPhase = new Uint8Array(MAX_AGENTS);
  /** 当前装载量（资源类型由 line 决定） */
  readonly cargo = new Uint16Array(MAX_AGENTS);
  /** 装/卸货倒计时 tick */
  readonly loadTicks = new Uint8Array(MAX_AGENTS);

  count = 0;

  spawn(homeX: number, homeZ: number, workX: number, workZ: number, kind = 0): number {
    if (this.count >= MAX_AGENTS) return -1;
    const i = this.count++;
    this.x[i] = homeX;
    this.z[i] = homeZ;
    this.vx[i] = 0;
    this.vz[i] = 0;
    this.targetX[i] = homeX;
    this.targetZ[i] = homeZ;
    this.state[i] = AgentState.AtHome;
    this.kind[i] = kind;
    this.homeX[i] = homeX;
    this.homeZ[i] = homeZ;
    this.workX[i] = workX;
    this.workZ[i] = workZ;
    this.wpIdx[i] = 0;
    this.wpCount[i] = 0;
    this.edgeIdx[i] = 0;
    this.edgeCount[i] = 0;
    this.tOnEdge[i] = 0;
    this.edgeDirAtoB[i] = 1;
    this.tripPhase[i] = TripPhase.WalkIn;
    this.lastReplanTick[i] = -1000;
    this.tripStartTick[i] = -1;
    this.leaveHomeHour[i] = 7.0;
    this.leaveWorkHour[i] = 17.5;
    // 货车字段默认值
    this.lineId[i] = -1;
    this.truckPhase[i] = 0;
    this.cargo[i] = 0;
    this.loadTicks[i] = 0;
    return i;
  }

  setWaypoints(i: number, pts: number[]): void {
    const n = Math.min(pts.length >> 1, MAX_WAYPOINTS);
    const base = i * MAX_WAYPOINTS * 2;
    for (let k = 0; k < n; k++) {
      this.waypoints[base + k * 2] = pts[k * 2];
      this.waypoints[base + k * 2 + 1] = pts[k * 2 + 1];
    }
    this.wpCount[i] = n;
    this.wpIdx[i] = 0;
  }

  getWaypoint(i: number, k: number): { x: number; z: number } {
    const base = i * MAX_WAYPOINTS * 2;
    return { x: this.waypoints[base + k * 2], z: this.waypoints[base + k * 2 + 1] };
  }

  /** 设置 edge 序列（E2 新增）。pts 为可选 entry/exit walk 航点。 */
  setEdgeTrip(i: number, edges: number[], entry: { x: number; z: number }, exit: { x: number; z: number }): void {
    const n = Math.min(edges.length, MAX_EDGES_PER_TRIP);
    const base = i * MAX_EDGES_PER_TRIP;
    for (let k = 0; k < n; k++) this.edgeSeq[base + k] = edges[k];
    this.edgeCount[i] = n;
    this.edgeIdx[i] = 0;
    this.tOnEdge[i] = 0;
    this.edgeDirAtoB[i] = 1;
    // entry / exit 存到 wp0 / wp1
    const wb = i * MAX_WAYPOINTS * 2;
    this.waypoints[wb] = entry.x;
    this.waypoints[wb + 1] = entry.z;
    this.waypoints[wb + 2] = exit.x;
    this.waypoints[wb + 3] = exit.z;
    this.wpCount[i] = 2;
    this.wpIdx[i] = 0;
    this.tripPhase[i] = n > 0 ? TripPhase.WalkIn : TripPhase.WalkOut;
    // 若没有 edge（同区出行），直接走对角线进 WalkOut，目标改为 exit（其实就是 work）
    if (n === 0) {
      this.targetX[i] = exit.x;
      this.targetZ[i] = exit.z;
    } else {
      this.targetX[i] = entry.x;
      this.targetZ[i] = entry.z;
    }
  }

  getEdgeId(i: number, k: number): number {
    return this.edgeSeq[i * MAX_EDGES_PER_TRIP + k];
  }

  reset(): void {
    this.count = 0;
    this.x.fill(0);
    this.z.fill(0);
    this.state.fill(0);
    this.wpCount.fill(0);
    this.wpIdx.fill(0);
    this.edgeCount.fill(0);
    this.edgeIdx.fill(0);
    this.tOnEdge.fill(0);
    this.tripPhase.fill(0);
    this.tripStartTick.fill(-1);
    // 货车字段
    this.lineId.fill(-1);
    this.truckPhase.fill(0);
    this.cargo.fill(0);
    this.loadTicks.fill(0);
  }
}

export { MAX_WAYPOINTS, MAX_EDGES_PER_TRIP };
