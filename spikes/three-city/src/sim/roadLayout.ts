/**
 * 道路布局规格（C3.4 · 双车道 + 人行道 · 靠右行驶）
 *
 * 这个文件是 sim 和 render 的共享真理：
 *   - 路宽、车道宽、人行道宽
 *   - 车道偏移量（决定"靠哪一侧行驶"）
 *   - 人行道偏移量
 *
 * 升级到四车道时，只改 LANES_PER_DIRECTION 和 driveLaneOffsets 即可，
 * 调用方（pathing / render）不需要改逻辑。
 *
 * 坐标系约定：
 *   - NS 路（南北向）：路面占据 [x0, x0 + ROAD_WIDTH] × [0, GRID_SIZE]
 *     路中心 cx = x0 + ROAD_WIDTH/2
 *     车辆沿 ±z 方向行驶
 *     "靠右行驶"：向 +z 走的车（北行）→ 靠 +x 一侧；向 -z 走的（南行）→ 靠 -x 一侧
 *
 *   - EW 路（东西向）：路面占据 [0, GRID_SIZE] × [z0, z0 + ROAD_WIDTH]
 *     路中心 cz = z0 + ROAD_WIDTH/2
 *     车辆沿 ±x 方向行驶
 *     "靠右行驶"：向 +x 走的车（东行）→ 靠 -z 一侧；向 -x 走的（西行）→ 靠 +z 一侧
 *     （想象向上看车头方向，"右手边"对应 z 的负向 / 正向）
 */

/** 总路宽（tile 单位）。从 2 升到 4，预留四车道升级空间。 */
export const ROAD_WIDTH = 4;

/** 单方向车道数。当前 1（双车道总），升级到 2 即四车道。 */
export const LANES_PER_DIRECTION = 1;

/** 人行道宽度（路面外侧两边各一条）。 */
export const SIDEWALK_WIDTH = 0.7;

/** 黄色中线的宽度。 */
export const CENTER_LINE_WIDTH = 0.08;

/** 车道宽 = (路宽 - 2*人行道) / 2方向 / 每方向车道数。 */
export const DRIVE_LANE_WIDTH =
  (ROAD_WIDTH - 2 * SIDEWALK_WIDTH) / 2 / LANES_PER_DIRECTION;

/**
 * 车辆"靠右行驶"时相对路中心的偏移。
 * 正值 = 偏向"路中心右侧"；具体到 NS/EW 由调用方根据行进方向决定符号。
 *
 * 双车道（LANES_PER_DIRECTION=1）：单条车道中心偏移 = 车道宽 / 2
 * 四车道（LANES_PER_DIRECTION=2）：返回 [近中线车道中心, 外侧车道中心]
 */
export function driveLaneOffsets(): number[] {
  const out: number[] = [];
  for (let k = 0; k < LANES_PER_DIRECTION; k++) {
    // 第 k 条车道中心：从路中心向外，先 0.5 个车道，再每条加 1 个车道宽
    out.push(DRIVE_LANE_WIDTH * (0.5 + k));
  }
  return out;
}

/** 默认（最里侧）车道中心偏移；当前等同于双车道情况下的唯一车道中心。 */
export const DEFAULT_DRIVE_OFFSET = driveLaneOffsets()[0];

/**
 * 人行道中心相对路中心的偏移。
 * 人行道在车道外侧：从路中心走 (车道总宽 + 人行道宽/2)
 */
export const SIDEWALK_OFFSET =
  DRIVE_LANE_WIDTH * LANES_PER_DIRECTION + SIDEWALK_WIDTH / 2;

/**
 * 给定 NS 路上的"行进方向 dz"（+1 北行 / -1 南行），
 * 返回相对路中心 x 的车道中心偏移（带正负号）。
 * 北行（+z）→ 靠右（+x），返回正；南行（-z）→ 靠右（-x），返回负。
 */
export function nsDriveOffset(dirZ: number): number {
  return dirZ >= 0 ? DEFAULT_DRIVE_OFFSET : -DEFAULT_DRIVE_OFFSET;
}

/**
 * 给定 EW 路上的"行进方向 dx"（+1 东行 / -1 西行），
 * 返回相对路中心 z 的车道中心偏移（带正负号）。
 * 东行（+x）→ 靠右（-z），返回负；西行（-x）→ 靠右（+z），返回正。
 */
export function ewDriveOffset(dirX: number): number {
  return dirX >= 0 ? -DEFAULT_DRIVE_OFFSET : DEFAULT_DRIVE_OFFSET;
}
