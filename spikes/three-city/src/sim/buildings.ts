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

  spawn(x: number, z: number, w: number, d: number, h: number, use: BuildingUse): number {
    if (this.count >= MAX_BUILDINGS) return -1;
    const i = this.count++;
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
    return i;
  }

  reset(): void {
    this.count = 0;
    this.population.fill(0);
    this.demand.fill(0);
    this.satisfaction.fill(0);
    this.tax.fill(0);
  }
}
