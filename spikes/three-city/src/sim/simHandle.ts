/**
 * 主线程侧的 Worker 句柄（C2 · 加入建筑同步）
 */

import type { SimSnapshot, SimStats } from './types';
import type { BuildingSpec } from '../render/buildingInstances';
import type { RoadRegion } from './traffic';

export interface SimHandleOptions {
  gridSize: number;
  seed: number;
  buildings: BuildingSpec[];
  roads: RoadRegion[];
  maxVisibleAgents: number;
  onSnapshot?: (snapshot: SimSnapshot, stats: SimStats) => void;
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
          seed: this.opts.seed,
          buildings: this.opts.buildings,
          roads: this.opts.roads,
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
    }
  }

  isReady(): boolean { return this.ready; }
  getSnapshot(): SimSnapshot | null { return this.latestSnapshot; }
  getStats(): SimStats | null { return this.latestStats; }
  getMessageIntervalMs(): number { return this.msgIntervalMs; }
  getBytesPerSec(): number { return this.bytesPerSec; }

  pause(): void { this.worker.postMessage({ type: 'pause' }); }
  resume(): void { this.worker.postMessage({ type: 'resume' }); }

  /** 运行时重置：可换代理数 / 建筑列表 / 种子。 */
  reset(opts: Partial<{ maxVisibleAgents: number; buildings: BuildingSpec[]; seed: number; roads: RoadRegion[] }> = {}): void {
    if (opts.maxVisibleAgents !== undefined) this.opts.maxVisibleAgents = opts.maxVisibleAgents;
    if (opts.buildings !== undefined) this.opts.buildings = opts.buildings;
    if (opts.seed !== undefined) this.opts.seed = opts.seed;
    if (opts.roads !== undefined) this.opts.roads = opts.roads;

    this.worker.postMessage({
      type: 'reset',
      config: {
        gridSize: this.opts.gridSize,
        seed: this.opts.seed,
        buildings: this.opts.buildings,
        roads: this.opts.roads,
        maxVisibleAgents: this.opts.maxVisibleAgents,
      },
    });
  }

  dispose(): void { this.worker.terminate(); }
}
