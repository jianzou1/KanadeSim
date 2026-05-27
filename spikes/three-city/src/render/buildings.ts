/**
 * 程序化低模建筑生成器（A2 探针）
 *
 * 设计原则：
 * - 一栋建筑 = 墙体 BoxGeometry + 屋顶（平顶 or 简化坡屋顶 PlaneGeometry）+ 可选窗户灯光小块
 * - 用 MeshLambertMaterial（flatShading）保持低多边形像素质感
 * - 一栋建筑 = 1-2 个 Mesh，A2 阶段不上 InstancedMesh（建筑数 <20，B2 才需要批渲染）
 * - 高度 / 宽度 / 颜色由 seed 决定，保证同一种子可复现
 */

import * as THREE from 'three';
import { PALETTE, pickRoof, pickWall, type BuildingKind } from './palette';

const wallGeomCache = new Map<string, THREE.BoxGeometry>();
function wallGeom(w: number, h: number, d: number): THREE.BoxGeometry {
  const key = `${w}x${h}x${d}`;
  let g = wallGeomCache.get(key);
  if (!g) {
    g = new THREE.BoxGeometry(w, h, d);
    wallGeomCache.set(key, g);
  }
  return g;
}

/**
 * 在 (tileX, tileZ) 位置生成一栋建筑。
 * tile 坐标单位 = 1 世界单位；建筑占地 width × depth 个 tile。
 */
export function makeBuilding(
  kind: BuildingKind,
  tileX: number,
  tileZ: number,
  width: number,
  depth: number,
  seed: number,
): THREE.Group {
  const group = new THREE.Group();
  group.userData.kind = kind;
  group.userData.tile = { x: tileX, z: tileZ, w: width, d: depth };

  // 高度按建筑类型差异化（住宅低、商业高、工业中等且扁平）
  const baseHeight =
    kind === 'residential' ? 1.5 + (seed % 3) * 0.6 :
    kind === 'commercial' ? 2.5 + (seed % 4) * 0.8 :
    1.2 + (seed % 2) * 0.5;

  // --- 墙体 ---
  const wallW = width * 0.86;
  const wallD = depth * 0.86;
  const wallH = baseHeight;
  const wallMat = new THREE.MeshLambertMaterial({
    color: pickWall(kind, seed),
    flatShading: true,
  });
  const walls = new THREE.Mesh(wallGeom(wallW, wallH, wallD), wallMat);
  walls.position.y = wallH / 2;
  group.add(walls);

  // --- 屋顶（平顶薄板，颜色反差强化轮廓）---
  const roofMat = new THREE.MeshLambertMaterial({
    color: pickRoof(kind),
    flatShading: true,
  });
  const roof = new THREE.Mesh(wallGeom(wallW + 0.08, 0.12, wallD + 0.08), roofMat);
  roof.position.y = wallH + 0.06;
  group.add(roof);

  // --- 工业建筑加一个烟囱小细节 ---
  if (kind === 'industrial') {
    const chim = new THREE.Mesh(
      wallGeom(0.3, 1.2, 0.3),
      new THREE.MeshLambertMaterial({ color: 0x4a4035, flatShading: true }),
    );
    chim.position.set(wallW * 0.3, wallH + 0.6, -wallD * 0.3);
    group.add(chim);
  }

  // --- 商业建筑加一个 "招牌" 暖色块 ---
  if (kind === 'commercial') {
    const sign = new THREE.Mesh(
      wallGeom(wallW * 0.7, 0.18, 0.04),
      new THREE.MeshBasicMaterial({ color: PALETTE.window }),
    );
    sign.position.set(0, wallH * 0.55, wallD / 2 + 0.04);
    group.add(sign);
  }

  // 定位到 tile 中心（tile 左下角 = 整数坐标）
  group.position.set(tileX + width / 2, 0, tileZ + depth / 2);

  return group;
}

/**
 * 一棵树：圆锥叶 + 圆柱树干
 */
export function makeTree(tileX: number, tileZ: number): THREE.Group {
  const g = new THREE.Group();
  const trunk = new THREE.Mesh(
    new THREE.CylinderGeometry(0.08, 0.1, 0.4, 6),
    new THREE.MeshLambertMaterial({ color: PALETTE.treeTrunk, flatShading: true }),
  );
  trunk.position.y = 0.2;
  g.add(trunk);

  const leaf = new THREE.Mesh(
    new THREE.ConeGeometry(0.35, 0.8, 6),
    new THREE.MeshLambertMaterial({ color: PALETTE.treeLeaf, flatShading: true }),
  );
  leaf.position.y = 0.8;
  g.add(leaf);

  g.position.set(tileX + 0.5, 0, tileZ + 0.5);
  return g;
}
