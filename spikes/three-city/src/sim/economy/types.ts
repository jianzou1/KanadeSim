/**
 * 经济链 V0 · 公共类型（迭代 3 · Phase 2 · C1）
 *
 * 设计来源：design.md §4
 *
 * 设计原则：
 *   - ID 类型用 brand 防止串号（ResourceId vs ProducerId vs NodeId vs LineId）
 *   - 配置表（Catalog）是只读常量；运行时实例（ChainNode / TransportLine）由 store 管
 *   - 所有数值能从 JSON 推；不在代码里写魔法数（除非 baseline 调参）
 */

// === Brand 类型 =============================================================

type Brand<K, T> = K & { readonly __brand: T };

export type ResourceId  = Brand<string, 'ResourceId'>;
export type ProducerId  = Brand<string, 'ProducerId'>;
export type NodeId      = Brand<number, 'NodeId'>;
export type LineId      = Brand<number, 'LineId'>;

export const RId = (s: string) => s as ResourceId;
export const PId = (s: string) => s as ProducerId;

// === Resource ==============================================================

export type ResourceLayer = 'raw' | 'intermediate' | 'end';

export interface ResourceDef {
  id: ResourceId;
  name: string;          // 中文展示名
  layer: ResourceLayer;
  /** 单价基线（design.md §4.5 收入公式里的 baseRate） */
  baseRate: number;
  /** 调色板用的色相，仅 UI/HUD 显示 */
  color: number;
}

// === Producer ==============================================================

export interface ProducerRecipe {
  /** 一次生产需要的输入（resource → 数量） */
  inputs:  Array<{ resource: ResourceId; qty: number }>;
  /** 一次生产产出（resource → 数量） */
  outputs: Array<{ resource: ResourceId; qty: number }>;
  /**
   * 每 tick 推进生产进度的"速度"（生产次数 / tick）。
   * 与 level 一起决定每年实际产能：
   *   capacity/年 = ticksPerYear × producePerTick × level
   */
  producePerTick: number;
}

export interface ProducerDef {
  id: ProducerId;
  name: string;            // 中文展示名
  recipe: ProducerRecipe;
  /** 占地 tile 大小（与 BuildingSpec 对齐） */
  footprint: { w: number; d: number };
  /** 默认高度（视觉用） */
  defaultHeight: number;
  /** 渲染 kind：决定走 buildingInstances 哪一类墙体；后续可扩 */
  buildingKind: 'residential' | 'commercial' | 'industrial';
  /** 默认调色种子（让生成的实例颜色相对稳定） */
  defaultSeed: number;
}

// === Town zone → 终端品需求映射 ============================================

export type TownZone = 'residential' | 'commercial' | 'industrial';

/** zone 消费哪些终端品（带"必需 vs 可选"权重）。 */
export interface ZoneDemandRule {
  zone: TownZone;
  /** 必需：缺会立刻让 fulfillment 跌 */
  required: ResourceId[];
  /** 可选：缺只让 fulfillment 略低 */
  optional: ResourceId[];
  /** 每 tile 每年的需求量（与 districts.ts area × DEMAND_PER_TILE 一致） */
  demandPerTilePerYear: number;
}
