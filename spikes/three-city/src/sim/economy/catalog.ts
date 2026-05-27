/**
 * 经济链 V0 · 配置表（迭代 3 · Phase 2 · C1）
 *
 * 设计来源：design.md §4.2
 *
 * V0 范围：
 *   - 6 种货物：grain / logs / planks / food / goods / materials
 *   - 5 种产业：farm / forest / sawMill / foodPlant / factory
 *   - 3 个 zone 终端：commercial 吃 food（必需）+ goods（可选）；industrial 吃 materials
 *
 * 数据扩展：后续把这份表外移到 JSON，由 zod 校验后加载。
 */

import {
  RId, PId,
  type ResourceDef, type ProducerDef, type ZoneDemandRule,
  type ResourceId, type ProducerId,
} from './types';

// === Resources =============================================================

export const RES = {
  grain:     RId('grain'),
  logs:      RId('logs'),
  planks:    RId('planks'),
  food:      RId('food'),
  goods:     RId('goods'),
  materials: RId('materials'),
} as const;

export const RESOURCE_CATALOG: Record<string, ResourceDef> = {
  [RES.grain]: {
    id: RES.grain, name: '谷子', layer: 'raw',
    baseRate: 1.0, color: 0xe6c264,
  },
  [RES.logs]: {
    id: RES.logs,  name: '原木', layer: 'raw',
    baseRate: 1.1, color: 0x8a5a3c,
  },
  [RES.planks]: {
    id: RES.planks, name: '木板', layer: 'intermediate',
    baseRate: 1.6, color: 0xc89a6e,
  },
  [RES.food]: {
    id: RES.food, name: '食物', layer: 'end',
    baseRate: 2.4, color: 0xd66b5a,
  },
  [RES.goods]: {
    id: RES.goods, name: '日用品', layer: 'end',
    baseRate: 2.8, color: 0x6cb4ff,
  },
  [RES.materials]: {
    id: RES.materials, name: '建材', layer: 'end',
    baseRate: 2.6, color: 0x9aa3ad,
  },
};

// === Producers =============================================================

export const PROD = {
  farm:      PId('farm'),
  forest:    PId('forest'),
  sawMill:   PId('sawMill'),
  foodPlant: PId('foodPlant'),
  factory:   PId('factory'),
} as const;

export const PRODUCER_CATALOG: Record<string, ProducerDef> = {
  [PROD.farm]: {
    id: PROD.farm, name: '农场',
    recipe: {
      inputs: [],
      outputs: [{ resource: RES.grain, qty: 1 }],
      producePerTick: 1.0,
    },
    footprint: { w: 3, d: 3 },
    defaultHeight: 1.4,
    buildingKind: 'industrial',     // 走工业建筑色板
    defaultSeed: 11,
  },
  [PROD.forest]: {
    id: PROD.forest, name: '林场',
    recipe: {
      inputs: [],
      outputs: [{ resource: RES.logs, qty: 1 }],
      producePerTick: 1.0,
    },
    footprint: { w: 3, d: 3 },
    defaultHeight: 1.6,
    buildingKind: 'industrial',
    defaultSeed: 13,
  },
  [PROD.sawMill]: {
    id: PROD.sawMill, name: '木材厂',
    recipe: {
      inputs:  [{ resource: RES.logs, qty: 2 }],
      outputs: [{ resource: RES.planks, qty: 1 }],
      producePerTick: 0.8,
    },
    footprint: { w: 4, d: 3 },
    defaultHeight: 2.8,
    buildingKind: 'industrial',
    defaultSeed: 17,
  },
  [PROD.foodPlant]: {
    id: PROD.foodPlant, name: '食品厂',
    recipe: {
      inputs:  [{ resource: RES.grain, qty: 2 }],
      outputs: [{ resource: RES.food, qty: 1 }],
      producePerTick: 0.8,
    },
    footprint: { w: 4, d: 3 },
    defaultHeight: 3.2,
    buildingKind: 'industrial',
    defaultSeed: 23,
  },
  [PROD.factory]: {
    id: PROD.factory, name: '综合工厂',
    recipe: {
      inputs:  [{ resource: RES.planks, qty: 1 }],
      outputs: [
        { resource: RES.goods,     qty: 1 },
        { resource: RES.materials, qty: 1 },
      ],
      producePerTick: 0.6,
    },
    footprint: { w: 4, d: 3 },
    defaultHeight: 3.6,
    buildingKind: 'industrial',
    defaultSeed: 29,
  },
};

// === Zone 需求 ============================================================

export const ZONE_DEMAND_RULES: ZoneDemandRule[] = [
  {
    zone: 'residential',
    // 居民间接消费：通过商业区获得 food / goods，不直接接收终端品
    required: [],
    optional: [],
    demandPerTilePerYear: 0,
  },
  {
    zone: 'commercial',
    required: [RES.food],
    optional: [RES.goods],
    // 商业区每 tile 每年需要 3 单位 food（粗调参，后续从平衡表读）
    demandPerTilePerYear: 3,
  },
  {
    zone: 'industrial',
    required: [RES.materials],
    optional: [],
    demandPerTilePerYear: 4,
  },
];

// === 工具函数 ==============================================================

export function getResource(id: ResourceId): ResourceDef {
  const r = RESOURCE_CATALOG[id];
  if (!r) throw new Error(`Unknown resource: ${id}`);
  return r;
}

export function getProducer(id: ProducerId): ProducerDef {
  const p = PRODUCER_CATALOG[id];
  if (!p) throw new Error(`Unknown producer: ${id}`);
  return p;
}

export function listProducers(): ProducerDef[] {
  return Object.values(PRODUCER_CATALOG);
}

export function listResources(): ResourceDef[] {
  return Object.values(RESOURCE_CATALOG);
}

export function getZoneRule(zone: 'residential' | 'commercial' | 'industrial'): ZoneDemandRule {
  return ZONE_DEMAND_RULES.find((r) => r.zone === zone)!;
}
