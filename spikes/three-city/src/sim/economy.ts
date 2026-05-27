/**
 * 区域级经济模拟（C2 + 迭代 2 · E3 加入通勤反馈）
 *
 * 设计原则（design.md §5）：
 * - 人口是统计实体（一个数字），不是真实代理
 * - 每个建筑 tick 一次（不是每个市民）→ N 个建筑 << N 个市民
 * - 反馈环：就业 ↔ 人口 ↔ 满意度 ↔ 税收（E3 起：+ 通勤时间）
 *
 * E3 改动：
 *   - stepEconomy 接收 commute 信号（avgCommuteTicks, targetCommuteTicks）
 *   - 住宅满意度 target -= COMMUTE_PENALTY × max(0, (avg - target) / target)
 *   - 暴露 avgCommute 到 metrics，给 HUD 显示
 */

import { BuildingUse, type BuildingStore } from './buildings';

/** 全市汇总指标（每 tick 重算一次）。 */
export interface CityMetrics {
  population: number;          // 总居住人口
  jobs: number;                // 总岗位（商业+工业容量）
  employed: number;            // 在职人数
  unemploymentRate: number;    // 0-1
  housingCapacity: number;     // 住宅总容量
  housingDemandPressure: number; // = population / housingCapacity，>1 表示挤
  commercialCapacity: number;  // 商业总容量
  commercialCoverage: number;  // 消费需求满足率
  taxPerTick: number;          // 本 tick 总税收
  satisfactionAvg: number;     // 全市平均满意度
  driverRate: number;          // 0-1：驾车通勤者比例（C3.2 加）
  /** E3 新增：当前平均通勤 tick 数（窗口估算） */
  avgCommuteTicks: number;
  /** E3 新增：commute target tick 数 */
  targetCommuteTicks: number;
}

/** E3：通勤反馈输入（worker 维护，stepEconomy 消费）。 */
export interface CommuteSignal {
  avgCommuteTicks: number;       // 最近 N 次到达的平均 trip ticks
  targetCommuteTicks: number;    // 容忍上限
}

const HOUSING_GROWTH_PER_TICK = 0.04;
const HOUSING_DECAY_PER_TICK = 0.06;
const SATISFACTION_LERP = 0.15;
const TAX_RATE_RESIDENTIAL = 0.02;
const TAX_RATE_COMMERCIAL = 0.05;
const TAX_RATE_INDUSTRIAL = 0.04;
const COMMERCIAL_DEMAND_PER_CAPITA = 0.4;

// 迭代 3 R1：COMMUTE_PENALTY / COMMUTE_RATIO_FULL_PENALTY 已删除（方向切到 TF，城市增长不再依赖通勤）

const EMPTY_METRICS: CityMetrics = {
  population: 0, jobs: 0, employed: 0, unemploymentRate: 0,
  housingCapacity: 0, housingDemandPressure: 0,
  commercialCapacity: 0, commercialCoverage: 0,
  taxPerTick: 0, satisfactionAvg: 0,
  driverRate: 0.1,
  avgCommuteTicks: 0,
  targetCommuteTicks: 0,
};

/**
 * 推进一 tick 经济模拟。返回更新后的城市指标。
 *
 * @param store    建筑库
 * @param commute  E3：通勤信号（不传则视作 avg=0，零扣减，与 C2 行为一致）
 */
export function stepEconomy(
  store: BuildingStore,
  commute?: CommuteSignal,
): CityMetrics {
  const n = store.count;
  if (n === 0) return { ...EMPTY_METRICS };

  let totalPop = 0;
  let totalHousingCap = 0;
  let totalCommCap = 0;
  let totalIndCap = 0;
  for (let i = 0; i < n; i++) {
    if (!store.alive[i]) continue;
    const u = store.use[i];
    const cap = store.capacity[i];
    if (u === BuildingUse.Residential) {
      totalPop += store.population[i];
      totalHousingCap += cap;
    } else if (u === BuildingUse.Commercial) {
      totalCommCap += cap;
    } else {
      totalIndCap += cap;
    }
  }

  const totalJobs = totalCommCap + totalIndCap;
  const labor = totalPop * 0.6;
  const employed = Math.min(labor, totalJobs);
  const unemploymentRate = labor > 0 ? Math.max(0, 1 - employed / labor) : 0;
  const housingDemandPressure = totalHousingCap > 0 ? totalPop / totalHousingCap : 0;
  const commercialDemand = totalPop * COMMERCIAL_DEMAND_PER_CAPITA;
  const commercialCoverage = commercialDemand > 0 ? Math.min(1, totalCommCap / commercialDemand) : 1;

  // 迭代 3 · Phase 1 R1：commute penalty 已裁掉。
  // 通勤时长依然由 worker 收集并显示在 HUD（观察用），但**不再扣住宅满意度**。
  // 真正驱动城市增减的反馈环已切到 districts.ts 的 fulfillment（货物供给）。
  // commute 参数保留只是为了不破坏接口；下面公式里直接当 0 用。
  void commute;

  let taxTotal = 0;
  let satSum = 0;
  let satCount = 0;

  for (let i = 0; i < n; i++) {
    if (!store.alive[i]) continue;
    const u = store.use[i];
    const cap = store.capacity[i];
    let pop = store.population[i];

    if (u === BuildingUse.Residential) {
      let target = 1.0;
      target -= unemploymentRate * 0.7;
      if (housingDemandPressure > 0.95) {
        target -= Math.min(0.4, (housingDemandPressure - 0.95) * 1.2);
      }
      // R1：原 commute penalty 已删除
      target = Math.max(0, Math.min(1, target));
      const sat = store.satisfaction[i] + (target - store.satisfaction[i]) * SATISFACTION_LERP;
      store.satisfaction[i] = sat;

      const driver = (sat - 0.5) * 2;
      let delta;
      if (driver >= 0) {
        const room = cap - pop;
        delta = driver * HOUSING_GROWTH_PER_TICK * cap;
        delta = Math.min(delta, room);
      } else {
        delta = driver * HOUSING_DECAY_PER_TICK * cap;
        delta = Math.max(delta, -pop);
      }
      const newPopF = pop + delta;
      const intPart = Math.floor(newPopF);
      const fracPart = newPopF - intPart;
      pop = intPart + (Math.random() < fracPart ? 1 : 0);
      pop = Math.max(0, Math.min(pop, cap));
      store.population[i] = pop;

      const tax = pop * TAX_RATE_RESIDENTIAL;
      store.tax[i] = tax;
      taxTotal += tax;
      satSum += sat;
      satCount++;
    } else {
      const fillRatio = totalJobs > 0 ? employed / totalJobs : 0;
      const targetPop = Math.round(cap * fillRatio);
      const sign = Math.sign(targetPop - pop);
      pop += sign * Math.max(1, Math.ceil(Math.abs(targetPop - pop) * 0.3));
      pop = Math.max(0, Math.min(pop, cap));
      store.population[i] = pop;

      let target;
      let tax;
      if (u === BuildingUse.Commercial) {
        target = commercialCoverage;
        tax = pop * TAX_RATE_COMMERCIAL;
      } else {
        target = Math.min(1, pop / Math.max(1, cap)) * 0.7 + 0.3;
        tax = pop * TAX_RATE_INDUSTRIAL;
      }
      const sat = store.satisfaction[i] + (target - store.satisfaction[i]) * SATISFACTION_LERP;
      store.satisfaction[i] = sat;
      store.tax[i] = tax;
      taxTotal += tax;
      satSum += sat;
      satCount++;
    }
  }

  let newTotalPop = 0;
  for (let i = 0; i < n; i++) {
    if (!store.alive[i]) continue;
    if (store.use[i] === BuildingUse.Residential) {
      newTotalPop += store.population[i];
    }
  }

  return {
    population: newTotalPop,
    jobs: totalJobs,
    employed: Math.round(employed),
    unemploymentRate,
    housingCapacity: totalHousingCap,
    housingDemandPressure,
    commercialCapacity: totalCommCap,
    commercialCoverage,
    taxPerTick: taxTotal,
    satisfactionAvg: satCount > 0 ? satSum / satCount : 0,
    driverRate: Math.max(0.1, Math.min(0.5,
      0.1 + (commercialCoverage * 0.2) + (Math.min(1, newTotalPop / 5000) * 0.2)
    )),
    avgCommuteTicks: commute?.avgCommuteTicks ?? 0,
    targetCommuteTicks: commute?.targetCommuteTicks ?? 0,
  };
}

/** 给新城市撒一点初始种子人口（首批移民），让经济能启动。 */
export function seedInitialPopulation(store: BuildingStore, seedPerHouse = 4): void {
  for (let i = 0; i < store.count; i++) {
    if (!store.alive[i]) continue;
    if (store.use[i] === BuildingUse.Residential) {
      store.population[i] = Math.min(seedPerHouse, store.capacity[i]);
      store.satisfaction[i] = 0.6;
    }
  }
}
