/**
 * 代理存储（SoA 布局）
 *
 * 所有代理字段独立 TypedArray，遵循 design.md §12 红线：
 *   const age = new Uint8Array(maxCitizens)
 *   const homeId = new Int32Array(maxCitizens)
 *
 * 不要写：
 *   class Citizen { update() {} render() {} }   ← 后期会爆
 *
 * C3+ 路径航点（最小可行版）：
 *   代理从家到公司走 4 个航点：home → entryRoad(home) → entryRoad(work) → work
 *   每个代理最多记 4 个航点 + 当前航点索引 wpIdx
 */

import { AgentState, MAX_AGENTS } from './types';

const MAX_WAYPOINTS = 5;

/**
 * 代理空间状态（位置 + 朝向 + 速度）
 * 用 Float32Array 是因为后续要做平滑插值，整数会有可见跳变
 */
export class AgentStore {
  // 位置（tile 单位，可为浮点）
  readonly x = new Float32Array(MAX_AGENTS);
  readonly z = new Float32Array(MAX_AGENTS);

  // 速度（单位 tile/秒）
  readonly vx = new Float32Array(MAX_AGENTS);
  readonly vz = new Float32Array(MAX_AGENTS);

  // 目标位置（家或公司）
  readonly targetX = new Float32Array(MAX_AGENTS);
  readonly targetZ = new Float32Array(MAX_AGENTS);

  // 状态机（每个值是 AgentState 枚举）
  readonly state = new Uint8Array(MAX_AGENTS);

  // 类型（0=市民, 1=车辆，B1 全部 0）
  readonly kind = new Uint8Array(MAX_AGENTS);

  // 家/公司 tile 索引（B1 用直接坐标做演示，C 阶段才用真正的建筑索引）
  readonly homeX = new Float32Array(MAX_AGENTS);
  readonly homeZ = new Float32Array(MAX_AGENTS);
  readonly workX = new Float32Array(MAX_AGENTS);
  readonly workZ = new Float32Array(MAX_AGENTS);

  // 路径航点（C3 · 上班 4 点 + 下班 4 点，反向用同样的航点）
  // [wp0X, wp0Z, wp1X, wp1Z, wp2X, wp2Z, wp3X, wp3Z]
  // wp0 = home, wp3 = work
  readonly waypoints = new Float32Array(MAX_AGENTS * MAX_WAYPOINTS * 2);
  /** 当前正在前往的航点索引 [0, MAX_WAYPOINTS) */
  readonly wpIdx = new Uint8Array(MAX_AGENTS);
  /** 该代理总共有效航点数（住宅↔工业之间最少 2、一般 4） */
  readonly wpCount = new Uint8Array(MAX_AGENTS);

  /** 实际活跃代理数（紧凑数组，索引 [0, count) 有效）。 */
  count = 0;

  /** 添加一个代理，返回索引。返回 -1 表示已满。 */
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
    return i;
  }

  /** 设置一组航点（≤ MAX_WAYPOINTS）。 */
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

  /** 取第 k 个航点的坐标。 */
  getWaypoint(i: number, k: number): { x: number; z: number } {
    const base = i * MAX_WAYPOINTS * 2;
    return { x: this.waypoints[base + k * 2], z: this.waypoints[base + k * 2 + 1] };
  }

  reset(): void {
    this.count = 0;
    this.x.fill(0);
    this.z.fill(0);
    this.state.fill(0);
    this.wpCount.fill(0);
    this.wpIdx.fill(0);
  }
}

export { MAX_WAYPOINTS };
