/**
 * 地面与道路（A2 探针）
 *
 * - 地面：一个大 PlaneGeometry，纯色
 * - 道路：手绘几张 PlaneGeometry 拼出十字路口 + 道路黄线
 * - 不上贴图，纯色块，验证"无美术资源也能像素风"
 */

import * as THREE from 'three';
import { PALETTE } from './palette';

export interface GroundLayout {
  size: number;          // 地面边长（单位 = tile）
  roads: Array<{
    /** 道路占地：[x, z, w, d] (tile 坐标) */
    rect: [number, number, number, number];
  }>;
}

export function makeGround(layout: GroundLayout): THREE.Group {
  const root = new THREE.Group();
  const { size, roads } = layout;

  // 草地
  const grassMat = new THREE.MeshLambertMaterial({
    color: PALETTE.ground,
    flatShading: true,
  });
  const grass = new THREE.Mesh(new THREE.PlaneGeometry(size, size), grassMat);
  grass.rotation.x = -Math.PI / 2;
  grass.position.set(size / 2, 0, size / 2);
  grass.receiveShadow = true;
  root.add(grass);

  // 草地暗格子（每隔 4 tile 一格，做出"地块"层次）
  const altMat = new THREE.MeshLambertMaterial({
    color: PALETTE.groundAlt,
    flatShading: true,
  });
  for (let x = 0; x < size; x += 4) {
    for (let z = 0; z < size; z += 4) {
      if (((x / 4) + (z / 4)) % 2 === 0) continue;
      const tile = new THREE.Mesh(new THREE.PlaneGeometry(4, 4), altMat);
      tile.rotation.x = -Math.PI / 2;
      tile.position.set(x + 2, 0.001, z + 2);
      root.add(tile);
    }
  }

  // 道路
  const roadMat = new THREE.MeshLambertMaterial({
    color: PALETTE.road,
    flatShading: true,
  });
  const stripeMat = new THREE.MeshBasicMaterial({ color: PALETTE.roadStripe });

  for (const r of roads) {
    const [x, z, w, d] = r.rect;
    const road = new THREE.Mesh(new THREE.PlaneGeometry(w, d), roadMat);
    road.rotation.x = -Math.PI / 2;
    road.position.set(x + w / 2, 0.01, z + d / 2);
    root.add(road);

    // 中央黄线（只画在长方向上）
    const stripeLen = Math.max(w, d) - 0.6;
    const stripeWidth = 0.08;
    const stripeIsHorizontal = w >= d;
    const stripe = new THREE.Mesh(
      new THREE.PlaneGeometry(
        stripeIsHorizontal ? stripeLen : stripeWidth,
        stripeIsHorizontal ? stripeWidth : stripeLen,
      ),
      stripeMat,
    );
    stripe.rotation.x = -Math.PI / 2;
    stripe.position.set(x + w / 2, 0.02, z + d / 2);
    root.add(stripe);
  }

  return root;
}
