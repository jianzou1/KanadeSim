/**
 * 车道 / 人行道偏移（迭代 2 · E2 升级路径后回填）
 *
 * E1 之前：pathing.ts 的 5 航点 L 形里 inline 算偏移
 * E2 起：寻路改成 edge 序列 + lerp(from,to)，偏移逻辑漂没了
 * 这个文件把 roadLayout.ts 暴露的 nsDriveOffset / ewDriveOffset / SIDEWALK_OFFSET
 * 重新接到 edge 投影上：
 *
 *   - Driver 走"靠右车道"
 *   - Walker 走"路右侧人行道"（行进方向的右手边）
 *
 * 用法：
 *   const { dx, dz } = laneOffset(edge, dirAtoB, isDriver)
 *   const projected = lerp(from, to, t) + (dx, dz)
 *
 * 给定 edge 的 axis（NS/EW）+ 当前行进方向（dirAtoB=1 表示 from→to）+ 代理类型，
 * 直接得到一个固定 offset，不需要每帧根据 dx/dz 重算 sign。
 */

import type { RoadEdge } from './roadGraph';
import { DEFAULT_DRIVE_OFFSET, SIDEWALK_OFFSET } from './roadLayout';
import type { RoadGraph } from './roadGraph';

/**
 * 计算代理在 edge 上行驶时相对 edge 中线的横向偏移。
 *
 * @param edge      当前 edge
 * @param graph     路网图（用来取 from/to 节点判断行进方向的几何符号）
 * @param dirAtoB   1 = from→to；0 = to→from
 * @param isDriver  true 走车道，false 走人行道
 * @returns         { dx, dz } 加到 lerp 结果上的世界坐标偏移
 */
export function laneOffset(
  edge: RoadEdge,
  graph: RoadGraph,
  dirAtoB: number,
  isDriver: boolean,
): { dx: number; dz: number } {
  const a = graph.nodes[edge.from];
  const b = graph.nodes[edge.to];
  if (edge.axis === 'NS') {
    // NS 路：沿 z 行进；车道 / 人行道 偏移 x
    // 行进方向 dz：+1 北行（+z），-1 南行（-z）
    const dz = (b.z - a.z) * (dirAtoB === 1 ? 1 : -1);
    const sgn = dz >= 0 ? 1 : -1;            // 北行 → +x（靠右）；南行 → -x
    const off = isDriver ? DEFAULT_DRIVE_OFFSET : SIDEWALK_OFFSET;
    return { dx: sgn * off, dz: 0 };
  } else {
    // EW 路：沿 x 行进；偏移 z
    // 东行（+x）→ 靠右 = -z；西行（-x）→ 靠右 = +z（与 roadLayout.ewDriveOffset 一致）
    const dx = (b.x - a.x) * (dirAtoB === 1 ? 1 : -1);
    const sgn = dx >= 0 ? -1 : 1;
    const off = isDriver ? DEFAULT_DRIVE_OFFSET : SIDEWALK_OFFSET;
    return { dx: 0, dz: sgn * off };
  }
}

/**
 * 给定一个 node 与"将要进入的 edge + 方向"，算出 entry / exit 那个 node 上
 * 应该停留的"车道点"或"人行道点"（节点中心 + 偏移）。
 *
 * 用于 WalkIn 的 target / Cruise 起点 snap：让代理从 home 走斜线时直接奔车道上的点，
 * 而不是先到 node 中心再侧移。
 */
export function nodeLanePoint(
  edge: RoadEdge,
  graph: RoadGraph,
  dirAtoB: number,
  isDriver: boolean,
  whichEnd: 'from' | 'to',
): { x: number; z: number } {
  const off = laneOffset(edge, graph, dirAtoB, isDriver);
  // dirAtoB=1 → 从 from 出发；whichEnd 是相对原 edge 端点的命名
  const node = whichEnd === 'from' ? graph.nodes[edge.from] : graph.nodes[edge.to];
  return { x: node.x + off.dx, z: node.z + off.dz };
}
