/**
 * 道路流量统计（E1 · 升级为 RoadGraph 委托）
 *
 * 历史背景（C3）：原 TrafficStore 直接管 4 条路矩形 region 的 flow/congestion。
 * E1 升级：内部改用 RoadGraph（per-edge 计数 + 父路聚合），对外接口保持兼容：
 *   - 仍接受 RoadRegion[] 作初始化参数
 *   - flow / congestion 暴露为"按父路聚合"的视图，给 HUD 4 条路视图用
 *   - pack() 输出仍是父路口径的 [flow, cong] × N
 *
 * 新增能力（给 E2 / E3 用）：
 *   - graph 属性：拿到完整 RoadGraph，做寻路 / per-edge 渲染
 *   - packEdges()：per-edge 打包，给 RoadHeatmap 改造时用
 */

import { RoadGraph } from './roadGraph';

export interface RoadRegion {
  /** 矩形左下角 + 大小（tile 单位） */
  x: number;
  z: number;
  w: number;
  d: number;
  /** 容量（代理数上限） */
  capacity: number;
}

export class TrafficStore {
  /** 原始 region 列表（程序化生成的井字路 + 玩家追加的）。 */
  readonly regions: RoadRegion[];
  readonly graph: RoadGraph;

  /** 父路聚合的 flow（HUD 兼容）。每次 countAgents 后刷新。 */
  flow: Uint32Array;
  /** 父路聚合的 congestion（HUD 兼容）。 */
  congestion: Float32Array;

  // 平滑参数（E3 会调到 0.15）
  private static readonly DEFAULT_EMA = 0.25;

  private gridSizeX: number;
  private gridSizeZ: number;
  /** 起始（程序化）region 数量，区分玩家追加段 */
  readonly baseRegionCount: number;
  /** 玩家段 id → 全局 region index 的映射（用于 removePlayerRoad） */
  private playerRegionByGlobalId = new Map<number, number>();

  constructor(regions: RoadRegion[], gridSizeX: number, gridSizeZ: number = gridSizeX) {
    this.regions = regions.slice();
    this.baseRegionCount = regions.length;
    this.gridSizeX = gridSizeX;
    this.gridSizeZ = gridSizeZ;
    this.graph = new RoadGraph();
    this.graph.setEma(TrafficStore.DEFAULT_EMA);
    this.graph.buildFromRegions(this.regions, gridSizeX, gridSizeZ);
    this.flow = new Uint32Array(this.regions.length);
    this.congestion = new Float32Array(this.regions.length);
  }

  /** 迭代 3 R4：增量加一段玩家铺的路。返回 region index。 */
  addPlayerRoad(seg: { x: number; z: number; w: number; d: number; capacity: number }, playerId: number): number {
    const idx = this.regions.length;
    this.regions.push({ x: seg.x, z: seg.z, w: seg.w, d: seg.d, capacity: seg.capacity });
    this.playerRegionByGlobalId.set(playerId, idx);
    this.rebuild();
    return idx;
  }

  /** 迭代 3 R4：删除玩家铺的某段路（用 RoadTool 端的 playerId）。 */
  removePlayerRoad(playerId: number): boolean {
    const idx = this.playerRegionByGlobalId.get(playerId);
    if (idx === undefined) return false;
    this.regions.splice(idx, 1);
    this.playerRegionByGlobalId.delete(playerId);
    // 删除后，所有 idx > 已删的 player 段需要把映射也减 1
    for (const [pid, gi] of this.playerRegionByGlobalId) {
      if (gi > idx) this.playerRegionByGlobalId.set(pid, gi - 1);
    }
    this.rebuild();
    return true;
  }

  /** 重建 RoadGraph + 重置 flow/congestion 数组到新长度。 */
  private rebuild(): void {
    this.graph.buildFromRegions(this.regions, this.gridSizeX, this.gridSizeZ);
    this.flow = new Uint32Array(this.regions.length);
    this.congestion = new Float32Array(this.regions.length);
  }

  /** EMA 调参对外开放（E3 用）。 */
  setEma(v: number): void { this.graph.setEma(v); }

  /** 每 tick 开始时清零 flow（保留接口给 tick 流程兼容）。 */
  resetFlow(): void {
    this.graph.resetFlow();
    this.flow.fill(0);
  }

  /**
   * 扫描所有代理位置，沿 edge 累计 flow，再聚合到父路给 HUD 用。
   */
  countAgents(agentX: Float32Array, agentZ: Float32Array, n: number): void {
    this.graph.countAgents(agentX, agentZ, n);
    // 聚合到父路
    const np = this.regions.length;
    for (let p = 0; p < np; p++) {
      let flow = 0;
      let congMax = 0;
      const eids = this.graph.edgesByParent[p] || [];
      for (const id of eids) {
        const e = this.graph.edges[id];
        flow += e.flow;
        if (e.congestion > congMax) congMax = e.congestion;
      }
      this.flow[p] = flow;
      this.congestion[p] = congMax;
    }
  }

  /** 父路口径打包 [flow, cong] × regions.length（HUD 4 条路兼容）。 */
  pack(): Float32Array {
    return this.graph.packParentRoads();
  }

  /** Per-edge 打包，给 RoadHeatmap 用（E1 后渲染层切换到这个口径）。 */
  packEdges(): Float32Array {
    return this.graph.packEdges();
  }
}
