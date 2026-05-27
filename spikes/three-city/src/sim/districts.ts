/**
 * 街区与需求模型（迭代 3 · M3.1）
 *
 * 设计来源：design.md §15 + §16
 *
 * 核心概念：
 *   - 一个 District 是一片同 zone 的街区，由 (col, row, zone) 唯一确定
 *   - 每个建筑属于一个 District（按落位的 col/row 划归）
 *   - District 有 demand（按容量推导）/ supplied（迭代 3 V0：用全市覆盖率近似分摊）/ fulfillment
 *   - 满足度连续高 → grow；连续低 → shrink；都遵循"使用即成长"反馈环
 *
 * 数据存放：
 *   - District 元数据存普通对象数组（数量小，不到几十个），不上 SoA
 *   - 每 building → districtId 映射存 Int32Array（容量固定 1024）
 *
 * 与现有系统的接口：
 *   - building 落位时调用 assignBuilding(idx, x, z) → districtId
 *   - 每 tick 调用 stepDistricts(buildingStore, metrics) → DistrictUpdate[]
 *
 * 不在本任务做：
 *   - 真实经济链 demand（M2 接入后用 ResourceCatalog 替换 V0 假需求）
 *   - 道路可达性约束（M1 完成后再加）
 */

import { BuildingUse, type BuildingStore } from './buildings';
import type { CityMetrics } from './economy';
import type { ResourceId } from './economy/types';
import { getZoneRule } from './economy/catalog';

/** 街区在地图上的矩形范围（tile 单位）。 */
export interface DistrictBounds {
  x: number;
  z: number;
  w: number;
  d: number;
}

/** 一个街区。 */
export interface District {
  id: number;
  col: number;            // 列号（地图横向）
  row: number;            // 行号（地图纵向）
  zone: BuildingUse;
  bounds: DistrictBounds;

  // 容量上限：街区不会无限长
  maxBuildings: number;

  // 动态状态
  buildings: number[];    // 属于本街区的 building idx
  demand: number;         // 当前需求（人/岗位/货物，迭代 3 V0 是"目标容量"）
  supplied: number;       // 实际供给（迭代 3 V0：建筑实际使用人数）
  fulfillment: number;    // 0..1.2，clamp 后

  // 反馈窗口（连续达标/不达标的 tick 数）
  goodTicks: number;
  badTicks: number;

  // 自生长冷却（避免每 tick 都试着 spawn）
  cooldownTicks: number;

  // === 迭代 3 T1：货物供给统计 =========================================
  /**
   * 各 ResourceId 在最近一年的累计到货量。
   * 货车每次卸货时累加；每 SUPPLY_DECAY_TICKS 衰减一次，模拟"年化"窗口。
   */
  suppliedByRes: Map<ResourceId, number>;
}

/** stepDistricts 返回的差量，告诉 worker 该 spawn / remove 哪些建筑。 */
export interface DistrictUpdate {
  type: 'spawn' | 'shrink';
  districtId: number;
  buildingIdx?: number;   // shrink 时指明删哪栋
  /** spawn 时：候选位置和尺寸（tile 单位），由 districts 模块基于街区找空位提供 */
  spawnHint?: {
    x: number;
    z: number;
    w: number;
    d: number;
    h: number;
  };
}

// === 反馈环参数 =============================================================

/** 连续多少 tick fulfillment ≥ HI 才允许 grow（4Hz 下 60 tick = 15s）。 */
const GROW_THRESHOLD_TICKS = 60;
/** 连续多少 tick fulfillment ≤ LO 才允许 shrink。 */
const SHRINK_THRESHOLD_TICKS = 80;
/** grow 触发阈值。 */
const FULFILL_HI = 0.85;
/** shrink 触发阈值。 */
const FULFILL_LO = 0.35;
/** 操作后冷却（避免抖动）。 */
const COOLDOWN_TICKS = 30;

/**
 * 货物 supplied 滑动窗口的衰减：每 N tick 把所有 supplied[res] 乘 SUPPLY_DECAY。
 * 4Hz × 60 = 240 tick = 60s 真实 ≈ 1 游戏天；衰减 0.92 ≈ "一年（30 天）后只剩 8%"。
 */
const SUPPLY_DECAY_INTERVAL_TICK = 240;
const SUPPLY_DECAY = 0.92;

/** 每个 zone 单位面积的"需求"（用来推导 demand）。 */
const DEMAND_PER_TILE: Record<BuildingUse, number> = {
  [BuildingUse.Residential]: 6,    // 住宅区 demand = 想住的人数
  [BuildingUse.Commercial]: 3,
  [BuildingUse.Industrial]: 4,
};

// === DistrictStore =========================================================

export class DistrictStore {
  readonly districts: District[] = [];
  /** building idx → district id；-1 表示未归属。 */
  private buildingToDistrict = new Int32Array(1024).fill(-1);

  reset(): void {
    this.districts.length = 0;
    this.buildingToDistrict.fill(-1);
  }

  /**
   * 根据现有路网/街区划分（如 scene.ts 的 9×3）创建 District 列表。
   * 实参由 worker 在 init 时传入，本模块不耦合具体地图布局。
   */
  initFromLayout(districts: Omit<District, 'id' | 'buildings' | 'demand' | 'supplied' | 'fulfillment' | 'goodTicks' | 'badTicks' | 'cooldownTicks' | 'suppliedByRes'>[]): void {
    this.districts.length = 0;
    for (let i = 0; i < districts.length; i++) {
      const seed = districts[i];
      this.districts.push({
        id: i,
        col: seed.col,
        row: seed.row,
        zone: seed.zone,
        bounds: seed.bounds,
        maxBuildings: seed.maxBuildings,
        buildings: [],
        demand: 0,
        supplied: 0,
        fulfillment: 0,
        goodTicks: 0,
        badTicks: 0,
        cooldownTicks: 0,
        suppliedByRes: new Map(),
      });
    }
  }

  /** 把已有建筑根据落位归到街区（init / 加载存档时调用）。 */
  assignBuilding(buildingIdx: number, x: number, z: number, w: number, d: number): number {
    const cx = x + w / 2;
    const cz = z + d / 2;
    for (const dist of this.districts) {
      const b = dist.bounds;
      if (cx >= b.x && cx < b.x + b.w && cz >= b.z && cz < b.z + b.d) {
        dist.buildings.push(buildingIdx);
        this.buildingToDistrict[buildingIdx] = dist.id;
        return dist.id;
      }
    }
    return -1;
  }

  getDistrictOf(buildingIdx: number): number {
    return this.buildingToDistrict[buildingIdx] ?? -1;
  }

  /** 从街区移除一栋建筑（删建筑时调用）。 */
  detachBuilding(buildingIdx: number): void {
    const did = this.buildingToDistrict[buildingIdx];
    if (did < 0) return;
    const dist = this.districts[did];
    const i = dist.buildings.indexOf(buildingIdx);
    if (i >= 0) dist.buildings.splice(i, 1);
    this.buildingToDistrict[buildingIdx] = -1;
  }

  /**
   * 迭代 3 T1：货车在 dst=town 卸货时调用。把 qty 加到对应街区的滚动累加器。
   */
  deliverToDistrict(districtId: number, res: ResourceId, qty: number): void {
    const dist = this.districts[districtId];
    if (!dist) return;
    const prev = dist.suppliedByRes.get(res) ?? 0;
    dist.suppliedByRes.set(res, prev + qty);
  }
}

// === 每 tick 的核心循环 =====================================================

/**
 * 推进一 tick 街区评估。
 *
 * 本函数纯计算 + 修改 District 内部统计；返回的 DistrictUpdate[] 让
 * 调用者（worker）实际去 spawn/remove 建筑——这样建筑增删的"权威"
 * 还在 BuildingStore，District 只负责"决策"。
 *
 * @param store    建筑库
 * @param metrics  城市指标（用于 V0 的全市分摊）
 * @param tick     当前 tick 计数
 * @param rng      随机数（用于选址抖动）
 * @returns 本 tick 需要执行的建筑增删
 */
export function stepDistricts(
  ds: DistrictStore,
  store: BuildingStore,
  metrics: CityMetrics,
  tick: number,
  rng: () => number,
): DistrictUpdate[] {
  const updates: DistrictUpdate[] = [];
  if (ds.districts.length === 0) return updates;

  // 迭代 3 T1：每 SUPPLY_DECAY_INTERVAL_TICK 衰减一次滚动累加，模拟年化
  if (tick > 0 && tick % SUPPLY_DECAY_INTERVAL_TICK === 0) {
    for (const dist of ds.districts) {
      for (const [r, v] of dist.suppliedByRes) {
        dist.suppliedByRes.set(r, v * SUPPLY_DECAY);
      }
    }
  }

  // === 计算每个 District 的 demand / supplied ============================
  // 迭代 3 T1：
  //   Residential : V0 沿用"住房压力"——R 街区没有直接货物消费，先保留旧逻辑
  //                 （未来住宅可以"间接通过商业供应满足生活需求"，但跨街区评估太复杂，先简化）
  //   Commercial  : fulfillment = min(suppliedByRes[r] / demandPerYear) 取必需品最低
  //                 demandPerYear = area × demandPerTilePerYear × buildings/maxBuildings
  //                 → 街区越大、建筑越多，需求越大；只看必需品（V0：food）
  //   Industrial  : 同上，但必需品换成 materials

  for (const dist of ds.districts) {
    const area = dist.bounds.w * dist.bounds.d;

    if (dist.zone === BuildingUse.Residential) {
      // V0 沿用旧逻辑（住宅没有直接货物消费）
      let cap = 0;
      let pop = 0;
      for (const bi of dist.buildings) {
        if (store.use[bi] === BuildingUse.Residential) {
          cap += store.capacity[bi];
          pop += store.population[bi];
        }
      }
      const potential = area * DEMAND_PER_TILE[dist.zone];
      dist.demand = potential;
      dist.supplied = cap;
      const ratio = potential > 0 ? cap / potential : 0;
      const pressure = metrics.housingDemandPressure;
      const utilization = cap > 0 ? pop / cap : 0;
      let f = 0.5;
      if (cap > 0) {
        f = utilization * 0.6 + (1 - ratio) * 0.4 + Math.min(0.4, Math.max(0, pressure - 0.7));
      } else {
        f = 0.4 + Math.min(0.6, Math.max(0, pressure - 0.5) * 1.2);
      }
      dist.fulfillment = clamp(f, 0, 1.2);

    } else if (dist.zone === BuildingUse.Commercial || dist.zone === BuildingUse.Industrial) {
      // 迭代 3 T1：基于货物 supplied 的真实 fulfillment
      const zoneStr = dist.zone === BuildingUse.Commercial ? 'commercial' : 'industrial';
      const rule = getZoneRule(zoneStr);
      // 年化需求：area × dpt × max(0.5, buildings/maxBuildings)
      // 设最小因子 0.5 让空街区也有"种子需求"，不至于一栋建筑都没就什么都不要
      const occupancyFactor = Math.max(0.5, dist.buildings.length / Math.max(1, dist.maxBuildings));
      const demandPerYear = area * rule.demandPerTilePerYear * occupancyFactor;
      dist.demand = demandPerYear;

      // 必需品 fulfillment = min(supplied[r] / demandPerYear)
      let requiredFulfill = 1.0;
      let suppliedSum = 0;
      if (rule.required.length === 0) {
        // 没有必需品（不应该到这里，但兜底）→ 当作 0.6
        requiredFulfill = 0.6;
      } else {
        for (const r of rule.required) {
          const s = dist.suppliedByRes.get(r) ?? 0;
          suppliedSum += s;
          const f = demandPerYear > 0 ? s / demandPerYear : 0;
          if (f < requiredFulfill) requiredFulfill = f;
        }
      }
      // 可选品加分（每种 + 0.1，最多 + 0.2）
      let bonus = 0;
      for (const r of rule.optional) {
        const s = dist.suppliedByRes.get(r) ?? 0;
        if (s > demandPerYear * 0.3) bonus += 0.1;
      }
      bonus = Math.min(0.2, bonus);

      dist.supplied = suppliedSum;
      dist.fulfillment = clamp(requiredFulfill + bonus, 0, 1.2);
    }
  }

  // === 反馈窗口 + 决策 ==================================================

  for (const dist of ds.districts) {
    if (dist.cooldownTicks > 0) {
      dist.cooldownTicks--;
      // 冷却期不积累 good/bad，避免冷却结束后立刻又触发
      dist.goodTicks = 0;
      dist.badTicks = 0;
      continue;
    }

    if (dist.fulfillment >= FULFILL_HI) {
      dist.goodTicks++;
      dist.badTicks = 0;
    } else if (dist.fulfillment <= FULFILL_LO) {
      dist.badTicks++;
      dist.goodTicks = 0;
    } else {
      // 中段：缓慢衰减，避免长时间徘徊后突然触发
      dist.goodTicks = Math.max(0, dist.goodTicks - 1);
      dist.badTicks = Math.max(0, dist.badTicks - 1);
    }

    // grow 决策
    if (dist.goodTicks >= GROW_THRESHOLD_TICKS && dist.buildings.length < dist.maxBuildings) {
      const hint = pickSpawnHint(dist, store, rng);
      if (hint) {
        updates.push({ type: 'spawn', districtId: dist.id, spawnHint: hint });
        dist.cooldownTicks = COOLDOWN_TICKS;
        dist.goodTicks = 0;
      }
    }

    // shrink 决策（保留至少 1 栋，以免完全清空后失去种子）
    if (dist.badTicks >= SHRINK_THRESHOLD_TICKS && dist.buildings.length > 1) {
      const target = pickShrinkTarget(dist, store, rng);
      if (target >= 0) {
        updates.push({ type: 'shrink', districtId: dist.id, buildingIdx: target });
        dist.cooldownTicks = COOLDOWN_TICKS;
        dist.badTicks = 0;
      }
    }
  }

  // 防止 unused warning
  void tick;

  return updates;
}

// === 选址 / 选拆 ============================================================

/**
 * 在街区内找一个空位，返回新建筑的 spawn hint。
 *
 * 算法（简化版，性能足够 30 个 District × 几次 spawn/秒）：
 *   1) 该 zone 默认占地（与 scene.ts 一致）：R=2x2、C=3x2、I=4x3
 *   2) 在 bounds 内按 0.5 步长扫，找不与已有建筑/道路 region 冲突的位置
 *   3) 取最先找到的；找不到返回 null
 *
 * 性能：街区 8×9 tile，0.5 步长 → 16×18 = 288 候选；
 *      乘以建筑数 N（街区内 ≤ maxBuildings ~= 12）做 AABB 检测；
 *      ≤ 4k 次浮点比较；30 个街区每次 spawn 检查一次足够。
 */
function pickSpawnHint(
  dist: District,
  store: BuildingStore,
  rng: () => number,
): { x: number; z: number; w: number; d: number; h: number } | null {
  const [w, d] = footprintFor(dist.zone);
  const h = heightFor(dist.zone, rng);
  const STEP = 0.5;
  const PADDING = 0.4;

  const candidates: Array<{ x: number; z: number }> = [];
  const xMin = dist.bounds.x + PADDING;
  const xMax = dist.bounds.x + dist.bounds.w - w - PADDING;
  const zMin = dist.bounds.z + PADDING;
  const zMax = dist.bounds.z + dist.bounds.d - d - PADDING;

  for (let z = zMin; z <= zMax; z += STEP) {
    for (let x = xMin; x <= xMax; x += STEP) {
      if (overlapsAnyBuilding(x, z, w, d, dist, store)) continue;
      candidates.push({ x, z });
    }
  }
  if (candidates.length === 0) return null;
  // 随机选一个，给城市生长一点不规则感
  const pick = candidates[Math.floor(rng() * candidates.length)];
  return { x: pick.x, z: pick.z, w, d, h };
}

function pickShrinkTarget(
  dist: District,
  store: BuildingStore,
  rng: () => number,
): number {
  if (dist.buildings.length === 0) return -1;
  // 简化：随机选一栋 satisfaction 最低的（前 30%）
  const candidates = dist.buildings
    .map((bi) => ({ idx: bi, sat: store.satisfaction[bi] }))
    .sort((a, b) => a.sat - b.sat);
  const pickPool = candidates.slice(0, Math.max(1, Math.ceil(candidates.length * 0.3)));
  return pickPool[Math.floor(rng() * pickPool.length)].idx;
}

function overlapsAnyBuilding(
  x: number, z: number, w: number, d: number,
  dist: District, store: BuildingStore,
): boolean {
  // 与街区内已有建筑做 AABB（带 0.4 边距）
  const PAD = 0.4;
  for (const bi of dist.buildings) {
    const bx = store.x[bi];
    const bz = store.z[bi];
    const bw = store.w[bi];
    const bd = store.d[bi];
    if (
      x + w + PAD > bx &&
      x < bx + bw + PAD &&
      z + d + PAD > bz &&
      z < bz + bd + PAD
    ) return true;
  }
  return false;
}

function footprintFor(zone: BuildingUse): [number, number] {
  if (zone === BuildingUse.Residential) return [2, 2];
  if (zone === BuildingUse.Commercial) return [3, 2];
  return [4, 3];
}

function heightFor(zone: BuildingUse, rng: () => number): number {
  const r = rng();
  if (zone === BuildingUse.Residential) return 1.4 + r * 1.0;
  if (zone === BuildingUse.Commercial) return 4.5 + r * 5.6;
  return 2.8 + r * 2.0;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
