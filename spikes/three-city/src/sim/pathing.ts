/**
 * 最小可行路径规划（C3.2 · 严格沿道路网移动）
 *
 * 设计：
 *   - 道路 = 井字 4 段路（2 NS + 2 EW）
 *   - 代理走 5 个航点：[home, upRoad, corner, downRoad, work]
 *   - 关键约束：所有从 access 起 → 到 access 终之间的航点必须落在路网交叉点上
 *     这样代理只在道路网上"L 形"行进，不会横穿别人街区
 *
 * 与 v1 的区别：
 *   - corner 是 NS×EW 真正交叉口（之前可能是非道路点）
 *   - access 选择更稳定：先决定"先走 NS 还是先走 EW"，对应 corner 落点
 *
 * 等 C1 + MVP 引入真道路图后，整体替换成 A* on graph。
 */

export interface PathContext {
  /** 南北路 x 中心坐标列表 */
  nsRoadCenters: number[];
  /** 东西路 z 中心坐标列表 */
  ewRoadCenters: number[];
}

/** 找数组里离 v 最近的元素的索引。 */
function nearestIndex(arr: number[], v: number): number {
  let bi = 0;
  let bd = Math.abs(arr[0] - v);
  for (let i = 1; i < arr.length; i++) {
    const d = Math.abs(arr[i] - v);
    if (d < bd) { bd = d; bi = i; }
  }
  return bi;
}

/**
 * 给一个起终点，返回 5 个航点：[起点, 上路点, 交叉口, 下路点, 终点]
 * 所有中间航点都在道路网上。
 *
 * @param sideOffset 步行专用：航点横向偏移路中心多少（让步行走人行道而非路中央）。
 *                   driver 传 0；walker 通常传 ±0.7（路宽 2 的两侧人行道）。
 *                   正负随机化交给调用方，这里只按符号决定方向。
 */
export function planPath(
  sx: number, sz: number,
  tx: number, tz: number,
  ctx: PathContext,
  sideOffset = 0,
): number[] {
  const ns = ctx.nsRoadCenters;
  const ew = ctx.ewRoadCenters;

  // 起点：选离 home 最近的 NS 路 x 或 EW 路 z 作为"上路边"
  // 规则：先走出街区到主路 → 在 NS 上还是 EW 上，看哪个更近
  const sNsIdx = nearestIndex(ns, sx);
  const sEwIdx = nearestIndex(ew, sz);
  const dNsS = Math.abs(ns[sNsIdx] - sx);
  const dEwS = Math.abs(ew[sEwIdx] - sz);

  // 终点：同样选最近的路
  const tNsIdx = nearestIndex(ns, tx);
  const tEwIdx = nearestIndex(ew, tz);
  const dNsT = Math.abs(ns[tNsIdx] - tx);
  const dEwT = Math.abs(ew[tEwIdx] - tz);

  // 起点上路点 + 终点下路点
  const startsOnNS = dNsS <= dEwS;
  const endsOnNS = dNsT <= dEwT;

  // 步行偏移：走 NS 路时沿 x 偏移、走 EW 路时沿 z 偏移
  // 偏移方向：以"起点应该走哪一侧"决定。简单规则：home 在路的左侧 → 走左人行道
  const startNsX = ns[sNsIdx];
  const startEwZ = ew[sEwIdx];
  const startSideNs = sideOffset === 0 ? 0 : (sx < startNsX ? -sideOffset : sideOffset);
  const startSideEw = sideOffset === 0 ? 0 : (sz < startEwZ ? -sideOffset : sideOffset);

  const endNsX = ns[tNsIdx];
  const endEwZ = ew[tEwIdx];
  const endSideNs = sideOffset === 0 ? 0 : (tx < endNsX ? -sideOffset : sideOffset);
  const endSideEw = sideOffset === 0 ? 0 : (tz < endEwZ ? -sideOffset : sideOffset);

  const upRoad = startsOnNS
    ? { x: startNsX + startSideNs, z: sz }
    : { x: sx, z: startEwZ + startSideEw };

  const downRoad = endsOnNS
    ? { x: endNsX + endSideNs, z: tz }
    : { x: tx, z: endEwZ + endSideEw };

  // 交叉口：保证转角点也在"同一侧人行道"，而不是路中心
  let corner: { x: number; z: number };
  if (startsOnNS && endsOnNS) {
    // 起终都在 NS 路上：corner 沿 upRoad 同 NS 路，z 取终点 EW 路 + 终点侧偏
    corner = {
      x: startNsX + startSideNs,
      z: ew[tEwIdx] + endSideEw,
    };
  } else if (!startsOnNS && !endsOnNS) {
    corner = {
      x: ns[tNsIdx] + endSideNs,
      z: startEwZ + startSideEw,
    };
  } else if (startsOnNS && !endsOnNS) {
    corner = {
      x: startNsX + startSideNs,
      z: ew[tEwIdx] + endSideEw,
    };
  } else {
    corner = {
      x: ns[tNsIdx] + endSideNs,
      z: startEwZ + startSideEw,
    };
  }

  return [
    sx, sz,                  // wp0: 起点（家或公司精确位置）
    upRoad.x, upRoad.z,      // wp1: 走出街区到路边
    corner.x, corner.z,      // wp2: 路网交叉口
    downRoad.x, downRoad.z,  // wp3: 终点对应路边
    tx, tz,                  // wp4: 终点
  ];
}
