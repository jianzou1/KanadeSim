/**
 * 道路图（迭代 2 · E1）
 *
 * 把"硬编码 4 段长矩形 region"升级为 node-edge 图：
 *   - Node: 路口或路网端点（含 NS×EW 内部交叉口、地图边界端点）
 *   - Edge: 两个 node 之间的路段（一段直线）
 *
 * 兼容契约（验收红线）：
 *   - 接受 Iter1 的 RoadRegion[] 作为输入
 *   - 内部把"井字 4 长条"切成"4 个内部交叉口 + 8 个边界端点 + 12 条 edge"
 *   - 每条 edge 携带 parentRoadId（原 region 索引），用于：
 *       a) 渲染层把同一条母路的所有边以同一颜色显示（可选合并）
 *       b) 流量统计对外的"4 条路"接口仍可由 edge 聚合得出
 *
 * 后续 E2 直接用：
 *   - fastestPath(srcNodeId, dstNodeId, costFn) → Edge[]
 *   - 邻接表 adj[nodeId] = Edge[]
 *
 * 不在本任务做：
 *   - 多车道（仍由 roadLayout.ts 的车道偏移负责，与图无关）
 *   - 真正的 A*（Dijkstra 已够 12 边规模）
 */

import type { RoadRegion } from './traffic';

/** 路网节点（路口或端点）。 */
export interface RoadNode {
  id: number;
  x: number;
  z: number;
}

/** 路网边（有向；井字双向用两条边对表示也可以，但 spike 阶段先用无向 + 双向遍历）。 */
export interface RoadEdge {
  id: number;
  from: number;          // node id
  to: number;            // node id
  length: number;        // tile 单位
  /** 名义限速（tile/秒），decoupled from 代理 baseSpeed，仅用于成本估时 */
  speed: number;
  /** 容量（同时容纳代理上限），从 parentRoad 按长度分摊 */
  capacity: number;
  /** 实时流量（每 tick 重置） */
  flow: number;
  /** 平滑后的拥堵度 0-1（与 traffic.ts 同语义） */
  congestion: number;
  /** 原 region 索引（兼容 C3 视觉/HUD） */
  parentRoadId: number;
  /** 走向：'NS' 沿 z 方向；'EW' 沿 x 方向 */
  axis: 'NS' | 'EW';
  /** AABB（tile 单位）：用来做"代理在哪条 edge 上"的反向投影 */
  bbox: { x: number; z: number; w: number; d: number };
}

/** 成本函数签名（E2 要用）。 */
export type EdgeCostFn = (e: RoadEdge, prev: RoadEdge | null) => number;

/**
 * 道路图。无向图，但 adj[from] / adj[to] 都包含同一 edge。
 */
export class RoadGraph {
  readonly nodes: RoadNode[] = [];
  readonly edges: RoadEdge[] = [];
  /** adj[nodeId] = edge ids 列表 */
  readonly adj: number[][] = [];
  /** parentRoadId → edge ids（HUD/兼容渲染用）。 */
  readonly edgesByParent: number[][] = [];

  /** 容量在原 region 上的密度系数（agent / tile²），与 scene.ts getRoadRegions 同口径。 */
  static readonly DEFAULT_CAPACITY_DENSITY = 0.6;

  /** 名义车速：tile/s。与 tick.ts SPEED_DRIVE 同口径。 */
  static readonly DEFAULT_SPEED = 4.5;

  /** 拥堵 EMA 系数（E3 调到 0.15，这里默认 0.25 与 traffic.ts 一致）。 */
  private ema = 0.25;
  setEma(v: number): void { this.ema = v; }

  // === 构建 ===============================================================

  private addNode(x: number, z: number): number {
    const id = this.nodes.length;
    this.nodes.push({ id, x, z });
    this.adj.push([]);
    return id;
  }

  /** 找已有 node（容差 0.01），找不到就建一个。 */
  private getOrAddNode(x: number, z: number): number {
    for (let i = 0; i < this.nodes.length; i++) {
      const n = this.nodes[i];
      if (Math.abs(n.x - x) < 0.01 && Math.abs(n.z - z) < 0.01) return n.id;
    }
    return this.addNode(x, z);
  }

  private addEdge(from: number, to: number, parentRoadId: number, axis: 'NS' | 'EW', bbox: RoadEdge['bbox'], parentCapacityPerLen: number): number {
    const a = this.nodes[from];
    const b = this.nodes[to];
    const length = Math.hypot(a.x - b.x, a.z - b.z);
    const id = this.edges.length;
    const e: RoadEdge = {
      id, from, to, length,
      speed: RoadGraph.DEFAULT_SPEED,
      capacity: Math.max(1, parentCapacityPerLen * length),
      flow: 0,
      congestion: 0,
      parentRoadId,
      axis,
      bbox,
    };
    this.edges.push(e);
    this.adj[from].push(id);
    this.adj[to].push(id);
    while (this.edgesByParent.length <= parentRoadId) this.edgesByParent.push([]);
    this.edgesByParent[parentRoadId].push(id);
    return id;
  }

  /**
   * 从 Iter1 的矩形 region 列表构建图。
   *
   * 算法：
   * 1. 区分 NS / EW（d > w 视作 NS）
   * 2. 每条 NS 路的中心 x = rx + rw/2；EW 路同理 z = rz + rd/2
   * 3. 内部交叉口 = 每条 NS × 每条 EW
   * 4. 每条母路按其上的交叉口序列切段，端点补到地图边界
   * 5. parentCapacityPerLen = region.capacity / region.length
   *
   * @param gridSizeX  地图 x 方向尺寸（EW 路终点）
   * @param gridSizeZ  地图 z 方向尺寸（NS 路终点）；省略则与 gridSizeX 相同（向后兼容正方形地图）
   */
  buildFromRegions(regions: RoadRegion[], gridSizeX: number, gridSizeZ: number = gridSizeX): void {
    this.nodes.length = 0;
    this.edges.length = 0;
    this.adj.length = 0;
    this.edgesByParent.length = 0;

    type Road = {
      id: number;
      axis: 'NS' | 'EW';
      center: number;       // NS: x；EW: z
      crossCenters: number[];   // 与之相交的对侧路中心（NS→EW.z 列表）
      reg: RoadRegion;
      length: number;
      capPerLen: number;
    };
    const roads: Road[] = regions.map((r, i) => {
      const isNS = r.d >= r.w;
      const len = isNS ? r.d : r.w;
      return {
        id: i,
        axis: (isNS ? 'NS' : 'EW') as 'NS' | 'EW',
        center: isNS ? r.x + r.w / 2 : r.z + r.d / 2,
        crossCenters: [],
        reg: r,
        length: len,
        capPerLen: r.capacity / Math.max(0.0001, len),
      };
    });

    const nsRoads = roads.filter((r) => r.axis === 'NS').sort((a, b) => a.center - b.center);
    const ewRoads = roads.filter((r) => r.axis === 'EW').sort((a, b) => a.center - b.center);

    // 填充 crossCenters
    for (const ns of nsRoads) ns.crossCenters = ewRoads.map((ew) => ew.center);
    for (const ew of ewRoads) ew.crossCenters = nsRoads.map((ns) => ns.center);

    // 切 NS 路：序列 = [0, 各 EW 中心..., gridSizeZ]
    for (const ns of nsRoads) {
      const cuts = [0, ...ns.crossCenters, gridSizeZ];
      // 路面 AABB（用真实路宽 = region 宽）
      const px = ns.reg.x;
      const pw = ns.reg.w;
      for (let k = 0; k < cuts.length - 1; k++) {
        const z0 = cuts[k];
        const z1 = cuts[k + 1];
        if (z1 - z0 < 0.001) continue;
        const a = this.getOrAddNode(ns.center, z0);
        const b = this.getOrAddNode(ns.center, z1);
        this.addEdge(a, b, ns.id, 'NS', { x: px, z: z0, w: pw, d: z1 - z0 }, ns.capPerLen);
      }
    }
    // 切 EW 路同理（沿 x 方向，端点为 0 和 gridSizeX）
    for (const ew of ewRoads) {
      const cuts = [0, ...ew.crossCenters, gridSizeX];
      const pz = ew.reg.z;
      const pd = ew.reg.d;
      for (let k = 0; k < cuts.length - 1; k++) {
        const x0 = cuts[k];
        const x1 = cuts[k + 1];
        if (x1 - x0 < 0.001) continue;
        const a = this.getOrAddNode(x0, ew.center);
        const b = this.getOrAddNode(x1, ew.center);
        this.addEdge(a, b, ew.id, 'EW', { x: x0, z: pz, w: x1 - x0, d: pd }, ew.capPerLen);
      }
    }
  }

  // === 空间查询 ===========================================================

  /** 找离 (x,z) 最近的 node，O(n)；spike 阶段 12 个 node 完全够。 */
  nearestNode(x: number, z: number): RoadNode {
    let best = this.nodes[0];
    let bd = Infinity;
    for (let i = 0; i < this.nodes.length; i++) {
      const n = this.nodes[i];
      const dx = n.x - x;
      const dz = n.z - z;
      const d = dx * dx + dz * dz;
      if (d < bd) { bd = d; best = n; }
    }
    return best;
  }

  /** 给一个点判断在哪条 edge 上（井字交叉处优先返回第一条命中）。 */
  edgeAt(x: number, z: number): RoadEdge | null {
    for (let i = 0; i < this.edges.length; i++) {
      const e = this.edges[i];
      const b = e.bbox;
      if (x >= b.x && x < b.x + b.w && z >= b.z && z < b.z + b.d) return e;
    }
    return null;
  }

  // === 流量 / 拥堵（迁移自 TrafficStore）=================================

  /** 每 tick 开始清零 flow。 */
  resetFlow(): void {
    for (let i = 0; i < this.edges.length; i++) this.edges[i].flow = 0;
  }

  /** 扫描代理位置，沿 edge 累加 flow，并 EMA 更新 congestion。 */
  countAgents(agentX: Float32Array, agentZ: Float32Array, n: number): void {
    this.resetFlow();
    const edges = this.edges;
    for (let i = 0; i < n; i++) {
      const x = agentX[i];
      const z = agentZ[i];
      for (let r = 0; r < edges.length; r++) {
        const b = edges[r].bbox;
        if (x >= b.x && x < b.x + b.w && z >= b.z && z < b.z + b.d) {
          edges[r].flow++;
          break;     // 一个代理只算一次（井字交叉处不重复）
        }
      }
    }
    for (let r = 0; r < edges.length; r++) {
      const e = edges[r];
      const target = Math.min(1, e.flow / e.capacity);
      e.congestion = e.congestion + (target - e.congestion) * this.ema;
    }
  }

  /** 父路聚合 [flow, congestion]，给 HUD 兼容 C3 的 4 条路视图用。 */
  packParentRoads(): Float32Array {
    const np = this.edgesByParent.length;
    const out = new Float32Array(np * 2);
    for (let p = 0; p < np; p++) {
      const eids = this.edgesByParent[p];
      let flow = 0;
      let congMax = 0;          // 取最大值代表"最堵的子段"
      for (const id of eids) {
        const e = this.edges[id];
        flow += e.flow;
        if (e.congestion > congMax) congMax = e.congestion;
      }
      out[p * 2] = flow;
      out[p * 2 + 1] = congMax;
    }
    return out;
  }

  /** Per-edge 打包 [flow0, cong0, flow1, cong1, ...]，供 RoadHeatmap 直接渲染。 */
  packEdges(): Float32Array {
    const out = new Float32Array(this.edges.length * 2);
    for (let i = 0; i < this.edges.length; i++) {
      out[i * 2] = this.edges[i].flow;
      out[i * 2 + 1] = this.edges[i].congestion;
    }
    return out;
  }

  // === 寻路（E2 用，E1 占位实现：直接 Dijkstra）==========================

  /**
   * 最短路径（按 costFn 加权），返回 edge id 序列；不可达返回 null。
   * Spike 阶段 12 个 node，二叉堆没必要，O(V²) 朴素 Dijkstra 足够。
   */
  fastestPath(srcNode: number, dstNode: number, costFn: EdgeCostFn): RoadEdge[] | null {
    const N = this.nodes.length;
    const dist = new Float64Array(N);
    const prevEdge = new Int32Array(N);
    const visited = new Uint8Array(N);
    for (let i = 0; i < N; i++) { dist[i] = Infinity; prevEdge[i] = -1; }
    dist[srcNode] = 0;

    while (true) {
      let u = -1;
      let bd = Infinity;
      for (let i = 0; i < N; i++) {
        if (!visited[i] && dist[i] < bd) { bd = dist[i]; u = i; }
      }
      if (u < 0 || u === dstNode) break;
      visited[u] = 1;
      for (const eid of this.adj[u]) {
        const e = this.edges[eid];
        const v = e.from === u ? e.to : e.from;
        if (visited[v]) continue;
        const prev = prevEdge[u] >= 0 ? this.edges[prevEdge[u]] : null;
        const w = costFn(e, prev);
        const nd = dist[u] + w;
        if (nd < dist[v]) { dist[v] = nd; prevEdge[v] = eid; }
      }
    }

    if (!isFinite(dist[dstNode])) return null;
    // 回溯
    const path: RoadEdge[] = [];
    let cur = dstNode;
    while (cur !== srcNode) {
      const eid = prevEdge[cur];
      if (eid < 0) return null;
      const e = this.edges[eid];
      path.push(e);
      cur = (e.from === cur ? e.to : e.from);
    }
    path.reverse();
    return path;
  }
}

/** 默认成本函数：纯长度（用于 E1 的 sanity check）。 */
export const lengthCost: EdgeCostFn = (e) => e.length;

/** E2 简版成本：time + comfort（转弯惩罚）。 */
export function makeTimeCost(turnPenalty = 0.5): EdgeCostFn {
  return (e, prev) => {
    const time = e.length / Math.max(0.1, e.speed * (1 - 0.6 * e.congestion));
    const comfort = prev && prev.axis !== e.axis ? turnPenalty : 0;
    return time + comfort;
  };
}
