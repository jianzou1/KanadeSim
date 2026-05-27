/**
 * 场景搭建（B2 · 大地图压测版 · 矩形地图 3×9）
 *
 * 当前布局：
 *   - 地图扩到 GRID_W × GRID_D = 104 × 32 tile（横向长方形）
 *   - 南北路 8 条，把 x 方向切成 9 列街区（每列 8 tile 宽，路宽 4）
 *   - 东西路 2 条，把 z 方向切成 3 行街区（保留旧布局）
 *   - 街区分配：左 3 列 = 居民区；中 3 列 = 工业区；右 3 列 = 商业区（每列 3 行同分类）
 *   - 建筑批量生成 500+ 栋，全部走 InstancedMesh
 */

import * as THREE from 'three';
import { makeTree } from './buildings';
import { makeGround, type GroundLayout } from './ground';
import { BuildingInstances, type BuildingSpec } from './buildingInstances';
import { RoadHeatmap } from './roadHeatmap';
import type { BuildingKind } from './palette';
import { ROAD_WIDTH } from '../sim/roadLayout';

// === 网格参数 ===============================================================
// x 方向：9 列街区 + 8 条南北路
//   每列街区宽 BLOCK_W，路宽 ROAD_WIDTH，从街区开始排（左侧不加路）
// z 方向：3 行街区 + 2 条东西路（保持旧布局）
const NUM_COLS = 9;            // 横向街区数
const NUM_ROWS = 3;            // 纵向街区数
const BLOCK_W = 8;             // 单列街区宽（tile）

// 历史 EW 布局保持不变：[9, 21]，切 z=[0..9]、[13..21]、[25..32]
const EW_ROADS = [9, 21] as const;
const GRID_D = 32;             // z 方向总深

// NS 路：第 i 条放在 BLOCK_W*(i+1) + ROAD_WIDTH*i，i 从 0..NUM_COLS-2 = 7
//   → [8, 20, 32, 44, 56, 68, 80, 92]
// 总宽 = NUM_COLS*BLOCK_W + (NUM_COLS-1)*ROAD_WIDTH = 72 + 32 = 104
const NS_ROADS: number[] = [];
for (let i = 0; i < NUM_COLS - 1; i++) {
  NS_ROADS.push(BLOCK_W * (i + 1) + ROAD_WIDTH * i);
}
const GRID_W = NUM_COLS * BLOCK_W + (NUM_COLS - 1) * ROAD_WIDTH;

// 兼容导出：仍叫 GRID_SIZE 给老代码用，等同 GRID_W；矩形地图时另外暴露 GRID_W/GRID_D。
export const GRID_SIZE = GRID_W;
export { GRID_W, GRID_D };

/**
 * 把"井"字路转成矩形 region 列表。
 * 容量按"车道部分面积"估（人行道不算车流容量）：
 *   每平方 tile 容纳 0.6 个代理 × 车道总宽 × 路长
 */
export function getRoadRegions(): Array<{ x: number; z: number; w: number; d: number; capacity: number }> {
  const out: Array<{ x: number; z: number; w: number; d: number; capacity: number }> = [];
  const driveLanesTotal = ROAD_WIDTH - 2 * 0.7;        // 与 roadLayout.SIDEWALK_WIDTH 同步
  // NS 路：贯穿整个 z 方向（GRID_D）
  for (const rx of NS_ROADS) {
    out.push({
      x: rx, z: 0, w: ROAD_WIDTH, d: GRID_D,
      capacity: driveLanesTotal * GRID_D * 0.6,
    });
  }
  // EW 路：贯穿整个 x 方向（GRID_W）
  for (const rz of EW_ROADS) {
    out.push({
      x: 0, z: rz, w: GRID_W, d: ROAD_WIDTH,
      capacity: GRID_W * driveLanesTotal * 0.6,
    });
  }
  return out;
}

/**
 * 迭代 3：把街区布局导出为 sim 模块需要的格式。
 *
 * 与 generateBuildings 同口径：9 列 × 3 行 = 27 个街区。
 * - col 0..2 = residential（zone 0）
 * - col 3..5 = industrial（zone 2）
 * - col 6..8 = commercial（zone 1）
 *
 * maxBuildings 取街区面积的简单估算：~3 tile²/栋。
 */
export function getDistrictLayout(): Array<{
  col: number;
  row: number;
  zone: 0 | 1 | 2;
  bounds: { x: number; z: number; w: number; d: number };
  maxBuildings: number;
}> {
  const blockOriginsX: number[] = [];
  for (let c = 0; c < NUM_COLS; c++) {
    blockOriginsX.push(c * (BLOCK_W + ROAD_WIDTH));
  }
  const blockOriginsZ = [
    0,
    EW_ROADS[0] + ROAD_WIDTH,
    EW_ROADS[1] + ROAD_WIDTH,
  ];
  const blockSizesZ = [
    EW_ROADS[0],
    EW_ROADS[1] - EW_ROADS[0] - ROAD_WIDTH,
    GRID_D - EW_ROADS[1] - ROAD_WIDTH,
  ];

  const out: ReturnType<typeof getDistrictLayout> = [];
  for (let row = 0; row < NUM_ROWS; row++) {
    for (let col = 0; col < NUM_COLS; col++) {
      const kind = kindOfColumn(col);
      const zone: 0 | 1 | 2 = kind === 'residential' ? 0 : kind === 'commercial' ? 1 : 2;
      const bw = BLOCK_W;
      const bd = blockSizesZ[row];
      const area = bw * bd;
      out.push({
        col, row, zone,
        bounds: { x: blockOriginsX[col], z: blockOriginsZ[row], w: bw, d: bd },
        // 按建筑占地估上限：R≈4 tile²、C≈6 tile²、I≈12 tile²，再除以 1.4 留间距
        maxBuildings: Math.max(2, Math.floor(area / (kind === 'residential' ? 5 : kind === 'commercial' ? 8 : 14))),
      });
    }
  }
  return out;
}

function isOnRoad(x: number, z: number, w: number, d: number): boolean {
  for (const rx of NS_ROADS) {
    if (x < rx + ROAD_WIDTH && x + w > rx) return true;
  }
  for (const rz of EW_ROADS) {
    if (z < rz + ROAD_WIDTH && z + d > rz) return true;
  }
  return false;
}

function makeSeededRand(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 计算一栋建筑的基础高度（按 kind + seed）。 */
function buildingHeight(kind: BuildingKind, seed: number): number {
  if (kind === 'residential') return 1.4 + (seed % 3) * 0.5;        // 1.4–2.4
  if (kind === 'commercial') return 4.5 + (seed % 5) * 1.4;         // 4.5–10.1（明显高楼）
  return 2.8 + (seed % 3) * 1.0;                                    // 工业 2.8–4.8（厂房 + 烟囱）
}

/**
 * 按列分配街区用途：
 *   col 0..2 → residential
 *   col 3..5 → industrial
 *   col 6..8 → commercial
 */
function kindOfColumn(col: number): BuildingKind {
  if (col < 3) return 'residential';
  if (col < 6) return 'industrial';
  return 'commercial';
}

/**
 * 程序化生成建筑列表。
 * @param targetCount 期望生成的建筑数，根据地图密度可能略少
 */
export function generateBuildings(targetCount: number, seed = 42): BuildingSpec[] {
  const rand = makeSeededRand(seed);
  const specs: BuildingSpec[] = [];

  // 街区原点（左下角）：x 方向 9 列、z 方向 3 行
  const blockOriginsX: number[] = [];
  for (let c = 0; c < NUM_COLS; c++) {
    blockOriginsX.push(c * (BLOCK_W + ROAD_WIDTH));
  }
  const blockSizesX: number[] = new Array(NUM_COLS).fill(BLOCK_W);

  const blockOriginsZ = [
    0,
    EW_ROADS[0] + ROAD_WIDTH,
    EW_ROADS[1] + ROAD_WIDTH,
  ];
  const blockSizesZ = [
    EW_ROADS[0],
    EW_ROADS[1] - EW_ROADS[0] - ROAD_WIDTH,
    GRID_D - EW_ROADS[1] - ROAD_WIDTH,
  ];

  let seedCounter = 0;

  outer:
  for (let row = 0; row < NUM_ROWS; row++) {
    for (let col = 0; col < NUM_COLS; col++) {
      if (specs.length >= targetCount) break outer;
      const kind = kindOfColumn(col);
      const ox = blockOriginsX[col];
      const oz = blockOriginsZ[row];
      const bw = blockSizesX[col];
      const bd = blockSizesZ[row];

      // 建筑占地：住宅 2x2、商业 3x2、工业 4x3
      const [w, d] = kind === 'residential' ? [2, 2]
                    : kind === 'commercial' ? [3, 2]
                    : [4, 3];

      // 在街区内按网格平铺，留出 0.4 tile 边距
      for (let z = oz + 0.4; z + d <= oz + bd; z += d + 0.4) {
        for (let x = ox + 0.4; x + w <= ox + bw; x += w + 0.4) {
          if (specs.length >= targetCount) break outer;
          if (isOnRoad(x, z, w, d)) continue;
          // 18% 概率留空（绿地/广场感）
          if (rand() < 0.18) continue;
          const sd = seedCounter++;
          specs.push({
            kind,
            x, z, w, d,
            h: buildingHeight(kind, sd),
            seed: sd,
          });
        }
      }
    }
  }

  return specs;
}

export function buildScene(targetBuildings = 500): {
  scene: THREE.Scene;
  pivot: THREE.Vector3;
  buildingInstances: BuildingInstances;
  buildingSpecs: BuildingSpec[];
  buildingCount: number;
  roadHeatmap: RoadHeatmap;
  gridW: number;
  gridD: number;
} {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x9fc8e8);
  // 雾起点按地图较长边略微拉远，避免横向地图边缘"被吞"
  scene.fog = new THREE.Fog(0x9fc8e8, 70, 160);

  // --- 光照 -----------------------------------------------------------------
  scene.add(new THREE.AmbientLight(0xfff4e0, 0.85));
  const sun = new THREE.DirectionalLight(0xfff0c8, 1.4);
  sun.position.set(12, 20, 8);
  sun.target.position.set(GRID_W / 2, 0, GRID_D / 2);
  scene.add(sun);
  scene.add(sun.target);
  scene.add(new THREE.HemisphereLight(0xcfe4ff, 0x8aa56a, 0.6));

  // --- 地面与道路 -----------------------------------------------------------
  const roads = getRoadRegions();
  const layout: GroundLayout = {
    sizeX: GRID_W,
    sizeZ: GRID_D,
    roads: roads.map((r) => ({ rect: [r.x, r.z, r.w, r.d] as [number, number, number, number] })),
  };
  scene.add(makeGround(layout));

  // --- 建筑（InstancedMesh）------------------------------------------------
  // 迭代 3：容量预留 2000，给"自动生长"的新建筑留 instance slot
  const buildingInstances = new BuildingInstances(Math.max(2000, targetBuildings + 800));
  const buildingSpecs = generateBuildings(targetBuildings);
  buildingInstances.setBuildings(buildingSpecs);
  scene.add(buildingInstances.group);

  // --- 装饰树（沿地图边缘点缀）---------------------------------------------
  // 底边和顶边
  for (let i = 0; i < 16; i++) {
    const x = 0.5 + i * (GRID_W / 16);
    scene.add(makeTree(x, 0.5));
    scene.add(makeTree(x, GRID_D - 1.2));
  }

  // --- 道路拥堵热力图（C3）-------------------------------------------------
  const roadHeatmap = new RoadHeatmap(roads.map((r) => ({ x: r.x, z: r.z, w: r.w, d: r.d })));
  scene.add(roadHeatmap.group);

  return {
    scene,
    pivot: new THREE.Vector3(GRID_W / 2, 0, GRID_D / 2),
    buildingInstances,
    buildingSpecs,
    buildingCount: buildingSpecs.length,
    roadHeatmap,
    gridW: GRID_W,
    gridD: GRID_D,
  };
}
