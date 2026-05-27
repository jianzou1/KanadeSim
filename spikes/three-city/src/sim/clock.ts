/**
 * 模拟时钟（迭代 2 · E4）
 *
 * 1 模拟日 = TICKS_PER_DAY = 240 tick = 60 秒（4Hz）
 * 阶段定义（24h 制小时）：
 *   06:00 – 09:00  Morning  早高峰
 *   09:00 – 17:00  Day      白天
 *   17:00 – 20:00  Evening  晚高峰
 *   20:00 – 06:00  Night    夜晚
 *
 * 这个文件是 sim 内"什么时候"的唯一真理。
 * tick.ts 不再自己算 phase；worker / HUD 都从这里取。
 */

import { TICKS_PER_DAY } from './types';

export const enum Phase {
  Night = 0,
  Morning = 1,
  Day = 2,
  Evening = 3,
}

/** 当前模拟时刻（24h 制 0-23.999...）。 */
export function hourOfDay(tick: number): number {
  return ((tick % TICKS_PER_DAY) / TICKS_PER_DAY) * 24;
}

/** 当前 day index（0,1,2,...）。 */
export function dayIndex(tick: number): number {
  return Math.floor(tick / TICKS_PER_DAY);
}

export function getPhase(tick: number): Phase {
  const hour = hourOfDay(tick);
  if (hour >= 6 && hour < 9) return Phase.Morning;
  if (hour >= 9 && hour < 17) return Phase.Day;
  if (hour >= 17 && hour < 20) return Phase.Evening;
  return Phase.Night;
}

export function isMorningRush(tick: number): boolean { return getPhase(tick) === Phase.Morning; }
export function isEveningRush(tick: number): boolean { return getPhase(tick) === Phase.Evening; }
export function isLeisureWindow(tick: number): boolean {
  const p = getPhase(tick);
  return p === Phase.Day;       // 暂时把"非高峰白天"视作 leisure
}

/** 把小时转回 tick 偏移（同日内）。 */
export function hourToTickOffset(hour: number): number {
  return Math.round((hour / 24) * TICKS_PER_DAY);
}

/** HUD 友好的 HH:MM 字符串。 */
export function tickToClock(tick: number): { hour: number; minute: number } {
  const hourProgress = (tick % TICKS_PER_DAY) / TICKS_PER_DAY;
  const totalMinutes = Math.floor(hourProgress * 24 * 60);
  return { hour: Math.floor(totalMinutes / 60), minute: totalMinutes % 60 };
}
