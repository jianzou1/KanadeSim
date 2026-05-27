/**
 * 区域级经济模拟（C2 · 第一层 · 系统内自循环）
 *
 * 设计原则（design.md §5）：
 * - 人口是统计实体（一个数字），不是真实代理
 * - 每个建筑 tick 一次（不是每个市民）→ N 个建筑 << N 个市民
 * - 反馈环：就业 ↔ 人口 ↔ 满意度 ↔ 税收
 *
 * 本版刻意不做：
 * - 通勤距离影响（C3 加路网后才有意义）
 * - 服务系统（消防/医疗/教育，迭代 2）
 * - 玩家手动放建筑（迭代 2 = C1）
 *
 * 经济模型（最小版）：
 *   1. 算城市总指标（总人口 / 总岗位 / 总商业容量 / 失业率 / 消费覆盖率）
 *   2. 逐建筑推进：
 *      - 住宅：人口按"满意度 × 就业供给"增减；满意度受失业率影响
 *      - 工业/商业：在职人数按"城市可用劳动力"匹配
 *      - 商业：满意度 = 消费覆盖率
 *      - 所有建筑：按当前人口产税
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
}

// 调参常量（C2 阶段先定个能跑通闭环的值，C3 可基于体验微调）
const HOUSING_GROWTH_PER_TICK = 0.04;     // 满意 100% 时每 tick 最多吸引 4% 容量
const HOUSING_DECAY_PER_TICK = 0.06;      // 满意 0% 时每 tick 最多流失 6%
const SATISFACTION_LERP = 0.15;           // 满意度向目标平滑过渡的速度
const TAX_RATE_RESIDENTIAL = 0.02;        // 每人每 tick 产 0.02 单位税
const TAX_RATE_COMMERCIAL = 0.05;
const TAX_RATE_INDUSTRIAL = 0.04;
const COMMERCIAL_DEMAND_PER_CAPITA = 0.4; // 每个市民产生 0.4 商业岗位需求

// 复用一个对象避免每 tick GC
const EMPTY_METRICS: CityMetrics = {
  population: 0, jobs: 0, employed: 0, unemploymentRate: 0,
  housingCapacity: 0, housingDemandPressure: 0,
  commercialCapacity: 0, commercialCoverage: 0,
  taxPerTick: 0, satisfactionAvg: 0,
  driverRate: 0.1,
};

/**
 * 推进一 tick 经济模拟。返回更新后的城市指标。
 */
export function stepEconomy(store: BuildingStore): CityMetrics {
  const n = store.count;
  if (n === 0) return { ...EMPTY_METRICS };

  // ─── Pass 1: 汇总城市级指标 ───────────────────────────────────────────
  let totalPop = 0;
  let totalHousingCap = 0;
  let totalCommCap = 0;
  let totalIndCap = 0;
  for (let i = 0; i < n; i++) {
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
  // 简化：劳动力人口 = 总人口的 60%
  const labor = totalPop * 0.6;
  const employed = Math.min(labor, totalJobs);
  const unemploymentRate = labor > 0 ? Math.max(0, 1 - employed / labor) : 0;
  const housingDemandPressure = totalHousingCap > 0 ? totalPop / totalHousingCap : 0;
  const commercialDemand = totalPop * COMMERCIAL_DEMAND_PER_CAPITA;
  const commercialCoverage = commercialDemand > 0 ? Math.min(1, totalCommCap / commercialDemand) : 1;

  // ─── Pass 2: 逐建筑更新 ───────────────────────────────────────────────
  let taxTotal = 0;
  let satSum = 0;
  let satCount = 0;

  for (let i = 0; i < n; i++) {
    const u = store.use[i];
    const cap = store.capacity[i];
    let pop = store.population[i];

    if (u === BuildingUse.Residential) {
      // 住宅满意度 = f(失业率，住房压力)
      //   失业率高 → 满意度降
      //   住房压力 > 1（挤）→ 满意度降
      let target = 1.0;
      target -= unemploymentRate * 0.7;
      if (housingDemandPressure > 0.95) {
        target -= Math.min(0.4, (housingDemandPressure - 0.95) * 1.2);
      }
      target = Math.max(0, Math.min(1, target));
      const sat = store.satisfaction[i] + (target - store.satisfaction[i]) * SATISFACTION_LERP;
      store.satisfaction[i] = sat;

      // 人口变化：满意度驱动
      // sat > 0.5 → 长人；sat < 0.5 → 流失
      const driver = (sat - 0.5) * 2;   // [-1, 1]
      let delta;
      if (driver >= 0) {
        const room = cap - pop;
        delta = driver * HOUSING_GROWTH_PER_TICK * cap;
        delta = Math.min(delta, room);
      } else {
        delta = driver * HOUSING_DECAY_PER_TICK * cap;   // 负数
        delta = Math.max(delta, -pop);
      }
      // 累加余数（带小数概率取整）
      const newPopF = pop + delta;
      const intPart = Math.floor(newPopF);
      const fracPart = newPopF - intPart;
      pop = intPart + (Math.random() < fracPart ? 1 : 0);
      pop = Math.max(0, Math.min(pop, cap));
      store.population[i] = pop;

      // 税收
      const tax = pop * TAX_RATE_RESIDENTIAL;
      store.tax[i] = tax;
      taxTotal += tax;
      satSum += sat;
      satCount++;
    } else {
      // 商业/工业：在职人数按"城市可用劳动力比例"匹配
      const fillRatio = totalJobs > 0 ? employed / totalJobs : 0;
      const targetPop = Math.round(cap * fillRatio);
      // 平滑过渡
      const sign = Math.sign(targetPop - pop);
      pop += sign * Math.max(1, Math.ceil(Math.abs(targetPop - pop) * 0.3));
      pop = Math.max(0, Math.min(pop, cap));
      store.population[i] = pop;

      // 满意度
      let target;
      let tax;
      if (u === BuildingUse.Commercial) {
        // 商业满意度 = 消费覆盖率
        target = commercialCoverage;
        tax = pop * TAX_RATE_COMMERCIAL;
      } else {
        // 工业满意度 = 用工充足率 + (1 - 失业率) * 0.5
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

  // 重新汇总（人口在 Pass 2 变了）
  let newTotalPop = 0;
  for (let i = 0; i < n; i++) {
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
    // 驾车率：经济越好（满意度高 + 商业繁荣）+ 城市越大 → 驾车率越高
    // 范围 [0.1, 0.5]，参考 design.md "经济驱动"
    driverRate: Math.max(0.1, Math.min(0.5,
      0.1 + (commercialCoverage * 0.2) + (Math.min(1, newTotalPop / 5000) * 0.2)
    )),
  };
}

/** 给新城市撒一点初始种子人口（首批移民），让经济能启动。 */
export function seedInitialPopulation(store: BuildingStore, seedPerHouse = 4): void {
  for (let i = 0; i < store.count; i++) {
    if (store.use[i] === BuildingUse.Residential) {
      store.population[i] = Math.min(seedPerHouse, store.capacity[i]);
      store.satisfaction[i] = 0.6;
    }
  }
}
