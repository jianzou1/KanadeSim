/**
 * 主线程侧的 Worker 句柄（C2 · 加入建筑同步）
 */

import type { SimSnapshot, SimStats } from './types';
import type { BuildingSpec } from '../render/buildingInstances';
import type { RoadRegion } from './traffic';
import type { DistrictInitSpec } from './worker';

export interface SimHandleOptions {
  /** 兼容字段：等价于 gridSizeX，正方形地图时只传这一个就够。 */
  gridSize: number;
  /** 矩形地图时传；缺省 = gridSize。 */
  gridSizeX?: number;
  /** 矩形地图时传；缺省 = gridSize。 */
  gridSizeZ?: number;
  seed: number;
  buildings: BuildingSpec[];
  roads: RoadRegion[];
  /** 迭代 3：街区布局。空数组 = 关闭自生长。 */
  districts?: DistrictInitSpec[];
  maxVisibleAgents: number;
  onSnapshot?: (snapshot: SimSnapshot, stats: SimStats) => void;
  /** 迭代 3 R3：路网变化（玩家增删路）时通知主线程刷新热力图等可视层。 */
  onRoadsChanged?: (regions: Array<{ x: number; z: number; w: number; d: number }>) => void;
}

export class SimHandle {
  private worker: Worker;
  private ready = false;
  private latestSnapshot: SimSnapshot | null = null;
  private latestStats: SimStats | null = null;

  private lastRecvAt = 0;
  private msgIntervalMs = 0;
  private bytesIn = 0;
  private bytesAt = performance.now();
  private bytesPerSec = 0;

  constructor(private opts: SimHandleOptions) {
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e) => this.handleMessage(e);
  }

  private handleMessage(e: MessageEvent): void {
    const msg = e.data;
    if (msg.type === 'loaded') {
      this.worker.postMessage({
        type: 'init',
        config: {
          gridSize: this.opts.gridSize,
          gridSizeX: this.opts.gridSizeX,
          gridSizeZ: this.opts.gridSizeZ,
          seed: this.opts.seed,
          buildings: this.opts.buildings,
          roads: this.opts.roads,
          districts: this.opts.districts,
          maxVisibleAgents: this.opts.maxVisibleAgents,
        },
      });
    } else if (msg.type === 'ready') {
      this.ready = true;
    } else if (msg.type === 'snapshot') {
      const snap = msg.payload as SimSnapshot;
      const stats = msg.stats as SimStats;

      const now = performance.now();
      if (this.lastRecvAt > 0) {
        this.msgIntervalMs = now - this.lastRecvAt;
      }
      this.lastRecvAt = now;

      this.bytesIn += stats.snapshotBytes;
      if (now - this.bytesAt >= 1000) {
        this.bytesPerSec = this.bytesIn * 1000 / (now - this.bytesAt);
        this.bytesIn = 0;
        this.bytesAt = now;
      }

      // 归还上一份 buffer
      if (this.latestSnapshot) {
        this.worker.postMessage(
          { type: 'return-buffer', buffer: this.latestSnapshot.agents.buffer },
          [this.latestSnapshot.agents.buffer],
        );
      }

      this.latestSnapshot = snap;
      this.latestStats = stats;
      this.opts.onSnapshot?.(snap, stats);
    } else if (msg.type === 'roads-changed') {
      // 迭代 3 R3：路网变化通知
      this.opts.onRoadsChanged?.(msg.regions);
    }
  }

  isReady(): boolean { return this.ready; }
  getSnapshot(): SimSnapshot | null { return this.latestSnapshot; }
  getStats(): SimStats | null { return this.latestStats; }
  getMessageIntervalMs(): number { return this.msgIntervalMs; }
  getBytesPerSec(): number { return this.bytesPerSec; }

  pause(): void { this.worker.postMessage({ type: 'pause' }); }
  resume(): void { this.worker.postMessage({ type: 'resume' }); }

  /** E5：设置倍速。合法值：0（暂停）/ 1 / 2 / 4。 */
  setSpeed(multiplier: number): void {
    this.worker.postMessage({ type: 'set-speed', multiplier });
  }

  /** E3：玩家"拓路"。把某条父路（0=NS-1, 1=NS-2, 2=EW-1, 3=EW-2）的容量乘 multiplier。 */
  boostRoad(parentRoadId: number, multiplier: number): void {
    this.worker.postMessage({ type: 'boost-road', parentRoadId, multiplier });
  }

  /** 迭代 3 R3：玩家铺路。playerId 来自 RoadTool。 */
  addRoad(playerId: number, seg: { x: number; z: number; w: number; d: number; capacity: number }): void {
    this.worker.postMessage({ type: 'add-road', playerId, seg });
  }

  /** 迭代 3 R3：玩家拆路。 */
  removeRoad(playerId: number): void {
    this.worker.postMessage({ type: 'remove-road', playerId });
  }

  /** 运行时重置：可换代理数 / 建筑列表 / 种子。 */
  reset(opts: Partial<{ maxVisibleAgents: number; buildings: BuildingSpec[]; seed: number; roads: RoadRegion[]; districts: DistrictInitSpec[] }> = {}): void {
    if (opts.maxVisibleAgents !== undefined) this.opts.maxVisibleAgents = opts.maxVisibleAgents;
    if (opts.buildings !== undefined) this.opts.buildings = opts.buildings;
    if (opts.seed !== undefined) this.opts.seed = opts.seed;
    if (opts.roads !== undefined) this.opts.roads = opts.roads;
    if (opts.districts !== undefined) this.opts.districts = opts.districts;

    this.worker.postMessage({
      type: 'reset',
      config: {
        gridSize: this.opts.gridSize,
        gridSizeX: this.opts.gridSizeX,
        gridSizeZ: this.opts.gridSizeZ,
        seed: this.opts.seed,
        buildings: this.opts.buildings,
        roads: this.opts.roads,
        districts: this.opts.districts,
        maxVisibleAgents: this.opts.maxVisibleAgents,
      },
    });
  }

  dispose(): void { this.worker.terminate(); }
}
