/**
 * 建筑模拟实体（C2 · 区域级人口模拟）
 *
 * 设计原则（design.md §5）：
 * - 建筑 ≠ 渲染网格。渲染层只关心 [x, z, w, d, h, color]，模拟层只关心 [kind, capacity, current]
 * - 建筑是"人口的容器"，本身不主动做任何事；tick 由 economy 模块按 building 列表批量推进
 *
 * 数据布局：仍走 SoA + TypedArray，与 design.md §12 红线一致
 */

import type { BuildingKind } from '../render/palette';

/** 建筑用途（数值化，便于 TypedArray 存）。 */
export const enum BuildingUse {
  Residential = 0,
  Commercial = 1,
  Industrial = 2,
}

export const MAX_BUILDINGS = 1024;

export function kindToUse(kind: BuildingKind): BuildingUse {
  switch (kind) {
    case 'residential': return BuildingUse.Residential;
    case 'commercial': return BuildingUse.Commercial;
    case 'industrial': return BuildingUse.Industrial;
  }
}

/**
 * 建筑容量曲线（每栋能容纳多少人/岗位）：
 * 用占地面积 × 高度系数 计算，符合"高楼住更多人"的直觉
 */
export function defaultCapacity(use: BuildingUse, w: number, d: number, h: number): number {
  const footprint = w * d;
  if (use === BuildingUse.Residential) {
    // 住宅：每平方 tile × 高度 ≈ 4 人
    return Math.round(footprint * h * 4);
  }
  if (use === BuildingUse.Commercial) {
    // 商业：每平方 tile × 高度 ≈ 2 岗位（更多面积花在客户区）
    return Math.round(footprint * h * 2);
  }
  // 工业：每平方 tile × 高度 ≈ 3 岗位
  return Math.round(footprint * h * 3);
}

/**
 * 建筑 SoA 存储
 */
export class BuildingStore {
  // 静态字段（建造后不变）
  readonly x = new Float32Array(MAX_BUILDINGS);
  readonly z = new Float32Array(MAX_BUILDINGS);
  readonly w = new Float32Array(MAX_BUILDINGS);
  readonly d = new Float32Array(MAX_BUILDINGS);
  readonly h = new Float32Array(MAX_BUILDINGS);
  readonly use = new Uint8Array(MAX_BUILDINGS);
  readonly capacity = new Uint16Array(MAX_BUILDINGS);

  // 动态字段（每 tick 变化）
  readonly population = new Uint16Array(MAX_BUILDINGS);    // 住宅：居民数 / 工作建筑：在职人数
  readonly demand = new Float32Array(MAX_BUILDINGS);       // 0-1：住宅入住意愿 / 商业服务到位率
  readonly satisfaction = new Float32Array(MAX_BUILDINGS); // 0-1：满意度
  readonly tax = new Float32Array(MAX_BUILDINGS);          // 每 tick 产税收

  count = 0;

  /** 已"销毁"标记（迭代 3 起，建筑可被自生长系统删除）。 */
  readonly alive = new Uint8Array(MAX_BUILDINGS);
  /** 出生 tick（用于动画 / 升级判定）。 */
  readonly bornTick = new Int32Array(MAX_BUILDINGS);
  /** 单调递增 ID（供主线程在快照中识别"哪栋是新增的"，与 idx 无关）。 */
  readonly uid = new Int32Array(MAX_BUILDINGS);
  private nextUid = 1;

  /**
   * 空闲 idx 池：被 destroy 的索引会被重用，避免 count 无限增长。
   * 简单栈实现，spike 阶段够用。
   */
  private freeList: number[] = [];

  spawn(x: number, z: number, w: number, d: number, h: number, use: BuildingUse, tick = 0): number {
    let i: number;
    if (this.freeList.length > 0) {
      i = this.freeList.pop()!;
    } else {
      if (this.count >= MAX_BUILDINGS) return -1;
      i = this.count++;
    }
    this.x[i] = x;
    this.z[i] = z;
    this.w[i] = w;
    this.d[i] = d;
    this.h[i] = h;
    this.use[i] = use;
    this.capacity[i] = defaultCapacity(use, w, d, h);
    this.population[i] = 0;
    this.demand[i] = 0;
    this.satisfaction[i] = 0.5;     // 初始中性
    this.tax[i] = 0;
    this.alive[i] = 1;
    this.bornTick[i] = tick;
    this.uid[i] = this.nextUid++;
    return i;
  }

  /** 销毁建筑（迭代 3 起）。idx 进入 freeList 等待复用。 */
  destroy(i: number): void {
    if (i < 0 || i >= this.count || !this.alive[i]) return;
    this.alive[i] = 0;
    this.population[i] = 0;
    this.capacity[i] = 0;
    this.tax[i] = 0;
    this.satisfaction[i] = 0;
    this.uid[i] = 0;
    this.freeList.push(i);
  }

  reset(): void {
    this.count = 0;
    this.population.fill(0);
    this.demand.fill(0);
    this.satisfaction.fill(0);
    this.tax.fill(0);
    this.alive.fill(0);
    this.bornTick.fill(0);
    this.uid.fill(0);
    this.freeList.length = 0;
    this.nextUid = 1;
  }
}
