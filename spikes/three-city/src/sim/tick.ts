/**
 * 单 tick 模拟逻辑（C3.1 · 沿道路移动）
 *
 * 改进自 B1 的直线移动：现在代理走 5 个航点
 *   home → 上路点 → 转折点 → 下路点 → work
 * 每到一个航点就切下一个；走完 wp 序列就到达目的地。
 *
 * 这样代理会聚集在 4 段井字路上，热力图和拥堵着色才有意义。
 *
 * C 阶段不做：
 *   - 真正的 A* 寻路（design.md §7 阶段 2/3，留到 MVP）
 *   - 拥堵反馈到速度（design.md §8 档 2）
 */

import { AgentState, AgentKind, TICK_MS, TICKS_PER_DAY } from './types';
import type { AgentStore } from './agents';
import { planPath, type PathContext } from './pathing';
import type { TrafficStore } from './traffic';

const DT = TICK_MS / 1000;
const SPEED_WALK = 1.6;        // tile/秒（步行）
const SPEED_DRIVE = 4.5;       // tile/秒（车，约 2.8 倍步行）
const ARRIVE_EPS = 0.04;
const CONGESTION_SPEED_PENALTY = 0.7;  // 拥堵 1.0 时车速衰减到 30%

const enum Phase {
  Night = 0,    // 20:00 – 06:00（在家睡觉）
  Morning = 1,  // 06:00 – 09:00（早高峰：去上班）
  Day = 2,      // 09:00 – 17:00（在公司工作）
  Evening = 3,  // 17:00 – 20:00（晚高峰：回家）
}

function getPhase(tick: number): Phase {
  // tick 时间 → [0, 1) 的"小时进度"
  const hourProgress = (tick % TICKS_PER_DAY) / TICKS_PER_DAY;
  // 24 小时映射
  const hour = hourProgress * 24;
  if (hour >= 6 && hour < 9) return Phase.Morning;
  if (hour >= 9 && hour < 17) return Phase.Day;
  if (hour >= 17 && hour < 20) return Phase.Evening;
  return Phase.Night;
}

/**
 * 取当前模拟时刻（HH:MM 字符串），主线程 HUD 用。
 * 不依赖 AgentStore，导出给 worker 直接调。
 */
export function tickToClock(tick: number): { hour: number; minute: number } {
  const hourProgress = (tick % TICKS_PER_DAY) / TICKS_PER_DAY;
  const totalMinutes = Math.floor(hourProgress * 24 * 60);
  return { hour: Math.floor(totalMinutes / 60), minute: totalMinutes % 60 };
}

/**
 * 给一个代理设置"从 a → b 沿路"的航点序列。
 */
function dispatchTrip(
  store: AgentStore,
  i: number,
  sx: number, sz: number,
  tx: number, tz: number,
  ctx: PathContext,
): void {
  // 步行走人行道（侧偏 0.7），驾车走路中央（侧偏 0）
  const side = store.kind[i] === AgentKind.Driver ? 0 : 0.7;
  const pts = planPath(sx, sz, tx, tz, ctx, side);
  store.setWaypoints(i, pts);
  // 第 0 个航点 = 起点 = 当前位置；从 wp1 开始追
  store.wpIdx[i] = 1;
  // targetX/Z 指向当前 wp
  const wp = store.getWaypoint(i, 1);
  store.targetX[i] = wp.x;
  store.targetZ[i] = wp.z;
}

/** 单 tick：推进所有代理（沿航点）。 */
export function stepTick(
  store: AgentStore,
  tick: number,
  ctx: PathContext,
  traffic: TrafficStore | null = null,
): void {
  const phase = getPhase(tick);
  const {
    x, z, vx, vz,
    targetX, targetZ,
    state, kind,
    homeX, homeZ, workX, workZ,
    wpIdx, wpCount,
    count,
  } = store;

  for (let i = 0; i < count; i++) {
    // --- 状态切换：触发新的航点序列 ---------------------------------------
    if (phase === Phase.Morning && state[i] === AgentState.AtHome) {
      state[i] = AgentState.GoingToWork;
      dispatchTrip(store, i, x[i], z[i], workX[i], workZ[i], ctx);
    } else if (phase === Phase.Evening &&
               (state[i] === AgentState.Working || state[i] === AgentState.GoingToWork)) {
      state[i] = AgentState.GoingHome;
      dispatchTrip(store, i, x[i], z[i], homeX[i], homeZ[i], ctx);
    }

    // --- 沿航点移动 ---------------------------------------------------------
    if (state[i] !== AgentState.GoingToWork && state[i] !== AgentState.GoingHome) continue;

    const dx = targetX[i] - x[i];
    const dz = targetZ[i] - z[i];
    const distSq = dx * dx + dz * dz;

    if (distSq < ARRIVE_EPS) {
      // 到达当前航点，切下一个
      const next = wpIdx[i] + 1;
      if (next < wpCount[i]) {
        wpIdx[i] = next;
        const wp = store.getWaypoint(i, next);
        targetX[i] = wp.x;
        targetZ[i] = wp.z;
      } else {
        // 走完了 → 到达目的地
        if (state[i] === AgentState.GoingToWork) state[i] = AgentState.Working;
        else if (state[i] === AgentState.GoingHome) state[i] = AgentState.AtHome;
        vx[i] = 0;
        vz[i] = 0;
      }
      continue;
    }

    // --- 速度计算 -----------------------------------------------------------
    const baseSpeed = kind[i] === AgentKind.Driver ? SPEED_DRIVE : SPEED_WALK;
    let speed = baseSpeed;

    // 仅对 driver 应用路段拥堵衰减；walker 视作"人行道"不堵
    if (traffic && kind[i] === AgentKind.Driver) {
      const cong = roadCongestionAt(x[i], z[i], traffic);
      if (cong > 0) {
        speed = baseSpeed * (1 - cong * CONGESTION_SPEED_PENALTY);
      }
    }

    const d = Math.sqrt(distSq);
    vx[i] = (dx / d) * speed;
    vz[i] = (dz / d) * speed;
    x[i] += vx[i] * DT;
    z[i] += vz[i] * DT;
  }
}

/** 查找一个点落在哪段路上的拥堵度；不在路上则返回 0。 */
function roadCongestionAt(px: number, pz: number, traffic: TrafficStore): number {
  const regions = traffic.regions;
  for (let r = 0; r < regions.length; r++) {
    const reg = regions[r];
    if (px >= reg.x && px < reg.x + reg.w && pz >= reg.z && pz < reg.z + reg.d) {
      return traffic.congestion[r];
    }
  }
  return 0;
}
