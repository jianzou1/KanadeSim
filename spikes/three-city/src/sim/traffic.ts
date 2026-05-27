/**
 * 道路流量统计（C3 · design.md §8 档 1）
 *
 * 最小可行版：
 *   - 道路 = 矩形 region 列表（井字路 = 4 段）
 *   - 每 tick 扫描代理位置，落在哪段路就该段 flow++
 *   - 拥堵 = flow / capacity → 0-1 标准化
 *
 * 这个模型够用的依据：
 *   - C3 阶段不做寻路（仍是 sim/tick.ts 的直线移动）
 *   - 玩家肉眼只需看"哪条路上的小方块密"
 *   - 等 C1 + MVP 加道路图后，把 RoadRegion[] 换成 edge 图即可，统计接口可保持
 *
 * 与渲染解耦：
 *   - sim 只产 flow / congestion 数字
 *   - render/roadHeatmap.ts 把数字着色到地面 InstancedMesh
 */

export interface RoadRegion {
  /** 矩形左下角 + 大小（tile 单位） */
  x: number;
  z: number;
  w: number;
  d: number;
  /** 容量（代理数上限） */
  capacity: number;
}

/**
 * 道路流量统计器
 * - flow[i]: 当前窗口内经过该段路的代理累计计数
 * - congestion[i]: 0-1，平滑后的拥堵度（用作着色）
 */
export class TrafficStore {
  readonly regions: RoadRegion[];
  readonly flow: Uint32Array;
  readonly congestion: Float32Array;

  // 平滑参数：congestion 跟踪 instantFlow/capacity 的 EMA
  private static readonly EMA = 0.25;

  constructor(regions: RoadRegion[]) {
    this.regions = regions;
    this.flow = new Uint32Array(regions.length);
    this.congestion = new Float32Array(regions.length);
  }

  /** 每 tick 开始时清零累计 flow（避免无限累积）。 */
  resetFlow(): void {
    this.flow.fill(0);
  }

  /**
   * 扫描所有代理位置，更新各路段 flow。
   * 调用方应在 stepTick 之后调用本方法，使用刚移动完的位置。
   */
  countAgents(agentX: Float32Array, agentZ: Float32Array, n: number): void {
    this.resetFlow();
    const regions = this.regions;
    const flow = this.flow;
    const len = regions.length;

    for (let i = 0; i < n; i++) {
      const x = agentX[i];
      const z = agentZ[i];
      for (let r = 0; r < len; r++) {
        const reg = regions[r];
        if (x >= reg.x && x < reg.x + reg.w && z >= reg.z && z < reg.z + reg.d) {
          flow[r]++;
          break;  // 一个代理最多算在一条路上（井字交叉处不重复计）
        }
      }
    }

    // 更新平滑拥堵度
    for (let r = 0; r < len; r++) {
      const target = Math.min(1, flow[r] / regions[r].capacity);
      this.congestion[r] = this.congestion[r] + (target - this.congestion[r]) * TrafficStore.EMA;
    }
  }

  /** 把 flow/congestion 打包成扁平 Float32Array，跨线程传给主线程渲染。 */
  pack(): Float32Array {
    // 每段路 2 个 float：[flow, congestion]
    const len = this.regions.length;
    const out = new Float32Array(len * 2);
    for (let r = 0; r < len; r++) {
      out[r * 2] = this.flow[r];
      out[r * 2 + 1] = this.congestion[r];
    }
    return out;
  }
}
