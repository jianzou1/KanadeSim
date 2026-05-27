/**
 * 地面与道路（C3.4 · 双车道 + 人行道）
 *
 * - 地面：一个大 PlaneGeometry，纯色
 * - 道路：每段路由三层组成
 *     底层：沥青 PlaneGeometry（占满 ROAD_WIDTH）
 *     中央：双黄线（两条平行细条，分隔双向车道）
 *     两侧：人行道（独立 PlaneGeometry，亮灰色）
 * - 不上贴图，纯色块，验证"无美术资源也能像素风"
 *
 * 参数全部从 sim/roadLayout.ts 取，未来升级到四车道无需改这里的逻辑。
 */

import * as THREE from 'three';
import { PALETTE } from './palette';
import {
  ROAD_WIDTH,
  SIDEWALK_WIDTH,
  CENTER_LINE_WIDTH,
  DRIVE_LANE_WIDTH,
  LANES_PER_DIRECTION,
} from '../sim/roadLayout';

export interface GroundLayout {
  /** 兼容字段：正方形地图边长。矩形地图时使用 sizeX/sizeZ。 */
  size?: number;
  /** 矩形地图：x 方向边长（缺省 = size）。 */
  sizeX?: number;
  /** 矩形地图：z 方向边长（缺省 = size）。 */
  sizeZ?: number;
  roads: Array<{
    /** 道路占地：[x, z, w, d] (tile 坐标) */
    rect: [number, number, number, number];
  }>;
}

// 渲染顺序（y 偏移，避免 z-fighting）
const Y_ROAD = 0.01;
const Y_SIDEWALK = 0.012;
const Y_LANE_DIVIDER = 0.018;
const Y_CENTER_LINE = 0.02;

export function makeGround(layout: GroundLayout): THREE.Group {
  const root = new THREE.Group();
  const { roads } = layout;
  const sizeX = layout.sizeX ?? layout.size ?? 32;
  const sizeZ = layout.sizeZ ?? layout.size ?? sizeX;

  // 草地
  const grassMat = new THREE.MeshLambertMaterial({
    color: PALETTE.ground,
    flatShading: true,
  });
  const grass = new THREE.Mesh(new THREE.PlaneGeometry(sizeX, sizeZ), grassMat);
  grass.rotation.x = -Math.PI / 2;
  grass.position.set(sizeX / 2, 0, sizeZ / 2);
  grass.receiveShadow = true;
  root.add(grass);

  // 草地暗格子（每隔 4 tile 一格，做出"地块"层次）
  const altMat = new THREE.MeshLambertMaterial({
    color: PALETTE.groundAlt,
    flatShading: true,
  });
  for (let x = 0; x < sizeX; x += 4) {
    for (let z = 0; z < sizeZ; z += 4) {
      if (((x / 4) + (z / 4)) % 2 === 0) continue;
      const tile = new THREE.Mesh(new THREE.PlaneGeometry(4, 4), altMat);
      tile.rotation.x = -Math.PI / 2;
      tile.position.set(x + 2, 0.001, z + 2);
      root.add(tile);
    }
  }

  // 道路材质
  const roadMat = new THREE.MeshLambertMaterial({
    color: PALETTE.road,
    flatShading: true,
  });
  const sidewalkMat = new THREE.MeshLambertMaterial({
    color: PALETTE.sidewalk,
    flatShading: true,
  });
  const centerLineMat = new THREE.MeshBasicMaterial({ color: PALETTE.roadStripe });
  // 车道分隔虚线（白线，将来升级 4 车道用；当前仅作为车道边缘的视觉提示，留 hook）
  const laneDividerMat = new THREE.MeshBasicMaterial({ color: 0xeeeae0 });

  for (const r of roads) {
    const [x, z, w, d] = r.rect;
    const isNS = d > w;     // 南北路：d 长 w 短
    const length = isNS ? d : w;
    const cx = x + w / 2;
    const cz = z + d / 2;

    // 1) 沥青底层
    const road = new THREE.Mesh(new THREE.PlaneGeometry(w, d), roadMat);
    road.rotation.x = -Math.PI / 2;
    road.position.set(cx, Y_ROAD, cz);
    root.add(road);

    // 2) 两侧人行道（路面两端各一条，沿路长方向铺）
    const sidewalkOffset =
      DRIVE_LANE_WIDTH * LANES_PER_DIRECTION + SIDEWALK_WIDTH / 2;
    for (const sign of [-1, +1]) {
      const sw = isNS
        ? new THREE.PlaneGeometry(SIDEWALK_WIDTH, length)
        : new THREE.PlaneGeometry(length, SIDEWALK_WIDTH);
      const swMesh = new THREE.Mesh(sw, sidewalkMat);
      swMesh.rotation.x = -Math.PI / 2;
      const sx = isNS ? cx + sign * sidewalkOffset : cx;
      const sz = isNS ? cz : cz + sign * sidewalkOffset;
      swMesh.position.set(sx, Y_SIDEWALK, sz);
      root.add(swMesh);
    }

    // 3) 中央双黄线（两条平行细线，间隔 0.18 tile，分隔上下行）
    const centerLineLength = length - 0.6;
    const centerOffset = 0.09;     // 双黄线半距
    for (const sign of [-1, +1]) {
      const cl = isNS
        ? new THREE.PlaneGeometry(CENTER_LINE_WIDTH, centerLineLength)
        : new THREE.PlaneGeometry(centerLineLength, CENTER_LINE_WIDTH);
      const clMesh = new THREE.Mesh(cl, centerLineMat);
      clMesh.rotation.x = -Math.PI / 2;
      const lx = isNS ? cx + sign * centerOffset : cx;
      const lz = isNS ? cz : cz + sign * centerOffset;
      clMesh.position.set(lx, Y_CENTER_LINE, lz);
      root.add(clMesh);
    }

    // 4) 车道分隔虚线（仅当 LANES_PER_DIRECTION > 1 时绘制，
    //    当前是双车道（每方向 1 条），跳过；预留四车道升级时启用）
    if (LANES_PER_DIRECTION > 1) {
      // 每方向相邻两条车道之间画一条白色虚线
      // 简化版：实线（虚线需要 LineDashedMaterial，先留接口）
      for (const dir of [-1, +1]) {
        for (let k = 1; k < LANES_PER_DIRECTION; k++) {
          const offset = DRIVE_LANE_WIDTH * k;
          const ld = isNS
            ? new THREE.PlaneGeometry(0.06, length - 0.4)
            : new THREE.PlaneGeometry(length - 0.4, 0.06);
          const ldMesh = new THREE.Mesh(ld, laneDividerMat);
          ldMesh.rotation.x = -Math.PI / 2;
          const lx = isNS ? cx + dir * offset : cx;
          const lz = isNS ? cz : cz + dir * offset;
          ldMesh.position.set(lx, Y_LANE_DIVIDER, lz);
          root.add(ldMesh);
        }
      }
    }
  }

  return root;
}
