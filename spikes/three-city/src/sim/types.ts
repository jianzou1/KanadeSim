/**
 * 模拟层数据 schema（B1 · 基线）
 *
 * 设计要点（design.md §12 §4 红线）：
 * - 代理用结构数组（SoA）+ TypedArray，避免十万级对象 GC
 * - 严格区分"持久状态"（在 Worker 内）和"快照"（传给主线程的扁平 Float32Array）
 * - 快照不要套对象，要能直接 transferable，零拷贝跨线程
 *
 * 命名约定：
 * - sim/ 内一律小写枚举（避免和 three.js 冲突）
 * - 时间单位统一用 tick（不是 ms），Worker 内 1 tick = 250ms（4Hz）
 */

// === 常量（B1 阶段；B2/C 会再调） ============================================

export const TICK_HZ = 4;
export const TICK_MS = 1000 / TICK_HZ;       // 250ms / tick

/** B1 阶段先开 2048 代理上限，B2 压测会推到 1000-2000 真实在线。 */
export const MAX_AGENTS = 2048;

/** 16×16 tile，与 A2 场景一致。C 阶段会扩到 32-64。 */
export const GRID_SIZE = 16;

/** 模拟一天的时长（C3.2）：60 秒真实 = 24 小时模拟 */
export const SECONDS_PER_DAY = 60;
export const TICKS_PER_DAY = TICK_HZ * SECONDS_PER_DAY;   // 240

// === 代理状态机（design.md §6）==============================================

export const enum AgentState {
  AtHome = 0,
  GoingToWork = 1,
  Working = 2,
  GoingShopping = 3,
  Shopping = 4,
  GoingHome = 5,
  // B1 阶段先只用 AtHome / GoingToWork / Working / GoingHome 四态
  // 其余状态留位，C 阶段补
}

/** 代理类型（C3.2 加车辆）。 */
export const enum AgentKind {
  Walker = 0,
  Driver = 1,
}

// === 快照协议（Worker → Main，每帧一次）=====================================

/**
 * 代理快照的字段布局（每个代理 4 个 float32 = 16 bytes）：
 *   [0] x        世界坐标（tile 单位）
 *   [1] z        世界坐标
 *   [2] state    AgentState（编码为 float）
 *   [3] kind     代理类型（0=市民, 1=车辆, ...）
 *
 * 一份完整快照 = MAX_AGENTS × 4 × 4 bytes = 32KB，可整个 transferable
 */
export const AGENT_STRIDE = 4;

export interface SimSnapshot {
  /** 当前实际激活的代理数（<= MAX_AGENTS）。 */
  activeAgents: number;
  /** 扁平代理数据，长度 = MAX_AGENTS * AGENT_STRIDE。 */
  agents: Float32Array;
  /** 当前 tick 编号，主线程可用来做插值。 */
  tick: number;
  /** 模拟时间（ms），从启动起累计。 */
  simTimeMs: number;
  /** 城市级经济指标（C2+）。建筑数为 0 时为 null。 */
  city: CityMetricsSnapshot | null;
  /** 道路流量（C3+）。每段路 2 个 float [flow, congestion]，长度 = roads.length * 2。 */
  roads: Float32Array | null;
  /** 本帧是否刚刚重采样了代理（C3.3）。主线程收到 true 时应跳过 prev/curr lerp，直接 snap。 */
  respawned: boolean;
}

/**
 * 城市级经济指标快照（扁平结构，跨线程友好）。
 * 与 sim/economy.ts CityMetrics 字段一致，独立定义避免循环依赖。
 */
export interface CityMetricsSnapshot {
  population: number;
  jobs: number;
  employed: number;
  unemploymentRate: number;
  housingCapacity: number;
  housingDemandPressure: number;
  commercialCapacity: number;
  commercialCoverage: number;
  taxPerTick: number;
  taxAccumulated: number;     // Worker 内累加的总税收（C2 新增）
  satisfactionAvg: number;
  driverRate: number;          // 0-1（C3.2 新增）
  /** 当前模拟时刻（24h 制 0-23.999） */
  hour: number;
}

/** Worker 计算耗时统计（HUD 用）。 */
export interface SimStats {
  lastTickMs: number;        // 上一 tick 计算耗时
  avgTickMs: number;         // 最近 60 tick 平均
  ticksPerSec: number;       // 实际频率
  snapshotBytes: number;     // 上次快照字节数
}
