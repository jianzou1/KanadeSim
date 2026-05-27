/**
 * 场景搭建（B2 · 大地图压测版）
 *
 * 相比 A2：
 *   - 地图扩到 32×32 tile（A2 是 16×16）
 *   - 道路升级为"井"字结构（南北 2 条 + 东西 2 条），形成 9 个街区
 *   - 建筑批量生成 500+ 栋，全部走 InstancedMesh
 *   - 树仍用单 Mesh（数量少），但减少到边缘装饰
 *   - 雾起点拉远（30→55），适配更大地图
 */

import * as THREE from 'three';
import { makeTree } from './buildings';
import { makeGround, type GroundLayout } from './ground';
import { BuildingInstances, type BuildingSpec } from './buildingInstances';
import { RoadHeatmap } from './roadHeatmap';
import type { BuildingKind } from './palette';

export const GRID_SIZE = 32;
const ROAD_WIDTH = 2;

// "井"字路：两条南北 + 两条东西，把地图分成 3×3 = 9 个街区
const NS_ROADS = [10, 22] as const;       // 南北路 x 起点
const EW_ROADS = [10, 22] as const;       // 东西路 z 起点

/**
 * 把"井"字路转成矩形 region 列表。
 * 每段路容量按面积估算：每平方 tile 容纳 8 个代理（直观调出来的）。
 */
export function getRoadRegions(): Array<{ x: number; z: number; w: number; d: number; capacity: number }> {
  const out: Array<{ x: number; z: number; w: number; d: number; capacity: number }> = [];
  for (const rx of NS_ROADS) {
    out.push({ x: rx, z: 0, w: ROAD_WIDTH, d: GRID_SIZE, capacity: ROAD_WIDTH * GRID_SIZE * 0.5 });
  }
  for (const rz of EW_ROADS) {
    out.push({ x: 0, z: rz, w: GRID_SIZE, d: ROAD_WIDTH, capacity: GRID_SIZE * ROAD_WIDTH * 0.5 });
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
  // 工作区显著拉高，与住宅区拉开视觉档次
  if (kind === 'residential') return 1.4 + (seed % 3) * 0.5;        // 1.4–2.4
  if (kind === 'commercial') return 4.5 + (seed % 5) * 1.4;         // 4.5–10.1（明显高楼）
  return 2.8 + (seed % 3) * 1.0;                                    // 工业 2.8–4.8（厂房 + 烟囱）
}

/**
 * 程序化生成建筑列表。
 * @param targetCount 期望生成的建筑数，根据地图密度可能略少
 */
export function generateBuildings(targetCount: number, seed = 42): BuildingSpec[] {
  const rand = makeSeededRand(seed);
  const specs: BuildingSpec[] = [];

  // 给每个街区分配主用途
  const blockKinds: BuildingKind[] = [
    'residential', 'commercial', 'residential',
    'commercial', 'industrial', 'commercial',
    'residential', 'commercial', 'residential',
  ];

  const blockOriginsX = [0, NS_ROADS[0] + ROAD_WIDTH, NS_ROADS[1] + ROAD_WIDTH];
  const blockOriginsZ = [0, EW_ROADS[0] + ROAD_WIDTH, EW_ROADS[1] + ROAD_WIDTH];
  const blockSizes = [
    NS_ROADS[0],
    NS_ROADS[1] - NS_ROADS[0] - ROAD_WIDTH,
    GRID_SIZE - NS_ROADS[1] - ROAD_WIDTH,
  ];
  const blockDepths = [
    EW_ROADS[0],
    EW_ROADS[1] - EW_ROADS[0] - ROAD_WIDTH,
    GRID_SIZE - EW_ROADS[1] - ROAD_WIDTH,
  ];

  let seedCounter = 0;

  for (let bi = 0; bi < 9; bi++) {
    if (specs.length >= targetCount) break;
    const kind = blockKinds[bi];
    const ox = blockOriginsX[bi % 3];
    const oz = blockOriginsZ[Math.floor(bi / 3)];
    const bw = blockSizes[bi % 3];
    const bd = blockDepths[Math.floor(bi / 3)];

    // 建筑占地：住宅 2x2、商业 3x2、工业 4x3
    const [w, d] = kind === 'residential' ? [2, 2]
                  : kind === 'commercial' ? [3, 2]
                  : [4, 3];

    // 在街区内按网格平铺，留出 0.5 tile 边距
    for (let z = oz + 0.4; z + d <= oz + bd; z += d + 0.4) {
      for (let x = ox + 0.4; x + w <= ox + bw; x += w + 0.4) {
        if (specs.length >= targetCount) break;
        if (isOnRoad(x, z, w, d)) continue;
        // 30% 概率留空（绿地/广场感）
        if (rand() < 0.18) continue;
        const seed = seedCounter++;
        specs.push({
          kind,
          x, z, w, d,
          h: buildingHeight(kind, seed),
          seed,
        });
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
} {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x9fc8e8);
  scene.fog = new THREE.Fog(0x9fc8e8, 55, 110);

  // --- 光照 -----------------------------------------------------------------
  scene.add(new THREE.AmbientLight(0xfff4e0, 0.85));
  const sun = new THREE.DirectionalLight(0xfff0c8, 1.4);
  sun.position.set(12, 20, 8);
  sun.target.position.set(GRID_SIZE / 2, 0, GRID_SIZE / 2);
  scene.add(sun);
  scene.add(sun.target);
  scene.add(new THREE.HemisphereLight(0xcfe4ff, 0x8aa56a, 0.6));

  // --- 地面与道路 -----------------------------------------------------------
  const roads = getRoadRegions();
  const layout: GroundLayout = {
    size: GRID_SIZE,
    roads: roads.map((r) => ({ rect: [r.x, r.z, r.w, r.d] as [number, number, number, number] })),
  };
  scene.add(makeGround(layout));

  // --- 建筑（InstancedMesh）------------------------------------------------
  const buildingInstances = new BuildingInstances(Math.max(800, targetBuildings + 100));
  const buildingSpecs = generateBuildings(targetBuildings);
  buildingInstances.setBuildings(buildingSpecs);
  scene.add(buildingInstances.group);

  // --- 装饰树（少量，单 Mesh）----------------------------------------------
  for (let i = 0; i < 8; i++) {
    scene.add(makeTree(0.5 + i * 3, GRID_SIZE - 1.2));
    scene.add(makeTree(GRID_SIZE - 1.2, 0.5 + i * 3));
  }

  // --- 道路拥堵热力图（C3）-------------------------------------------------
  const roadHeatmap = new RoadHeatmap(roads.map((r) => ({ x: r.x, z: r.z, w: r.w, d: r.d })));
  scene.add(roadHeatmap.group);

  return {
    scene,
    pivot: new THREE.Vector3(GRID_SIZE / 2, 0, GRID_SIZE / 2),
    buildingInstances,
    buildingSpecs,
    buildingCount: buildingSpecs.length,
    roadHeatmap,
  };
}
