/**
 * 建筑批渲染（B2 · InstancedMesh 版）
 *
 * 替代 A2 的 buildings.ts —— A2 给每栋建筑一个 Group/Mesh，<20 栋无所谓，
 * 但 B2 要上 500 栋，必须批渲染。
 *
 * 思路：
 *   - 三类建筑（住宅/商业/工业）各一个 InstancedMesh
 *     - 几何：统一为 1×1×1 的 BoxGeometry，translate(0, 0.5, 0) 让原点在底面
 *     - 通过 instanceMatrix 的 scale 来控制 width/depth/height
 *     - 通过 instanceColor 控制每栋墙体颜色
 *   - 屋顶：再单独一个 InstancedMesh（共享几何 + 单色），数量 = 总建筑数
 *
 * 总 draw call = 4 （3 类墙体 + 1 类屋顶），无论 500 栋还是 5000 栋
 *
 * 取舍：放弃 A2 时的烟囱、商业招牌细节（如果 B2 需要，再加额外一个 InstancedMesh）
 */

import * as THREE from 'three';
import { PALETTE, pickWall, pickRoof, type BuildingKind } from './palette';

const DUMMY = new THREE.Object3D();
const COLOR = new THREE.Color();

export interface BuildingSpec {
  kind: BuildingKind;
  /** 占地左下角 tile 坐标 */
  x: number;
  z: number;
  /** 占地大小（tile） */
  w: number;
  d: number;
  /** 高度（世界单位） */
  h: number;
  /** 调色种子 */
  seed: number;
}

export class BuildingInstances {
  readonly group: THREE.Group;
  private wallsMesh = new Map<BuildingKind, THREE.InstancedMesh>();
  private roofMesh: THREE.InstancedMesh;
  private capacity: number;
  private roofCount = 0;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.group = new THREE.Group();

    // 共享几何：1×1×1 立方体，底面在 y=0
    const wallGeom = new THREE.BoxGeometry(1, 1, 1);
    wallGeom.translate(0, 0.5, 0);

    // 三类墙体（每类 capacity 上限，实际只用一部分）
    for (const kind of ['residential', 'commercial', 'industrial'] as const) {
      const mat = new THREE.MeshLambertMaterial({ flatShading: true });
      const mesh = new THREE.InstancedMesh(wallGeom, mat, capacity);
      mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
      mesh.instanceColor = new THREE.InstancedBufferAttribute(
        new Float32Array(capacity * 3),
        3,
      );
      mesh.count = 0;
      this.wallsMesh.set(kind, mesh);
      this.group.add(mesh);
    }

    // 屋顶：薄板，y 由 scale 控制（其实只用 X/Z scale，Y 固定 0.12）
    const roofGeom = new THREE.BoxGeometry(1, 1, 1);
    roofGeom.translate(0, 0.5, 0);
    const roofMat = new THREE.MeshLambertMaterial({ flatShading: true });
    this.roofMesh = new THREE.InstancedMesh(roofGeom, roofMat, capacity * 3);
    this.roofMesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    this.roofMesh.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(capacity * 3 * 3),
      3,
    );
    this.roofMesh.count = 0;
    this.group.add(this.roofMesh);
  }

  /** 一次性提交一组建筑（C 阶段会改成增量 add/remove）。 */
  setBuildings(specs: BuildingSpec[]): void {
    // 按 kind 分组
    const byKind: Record<BuildingKind, BuildingSpec[]> = {
      residential: [],
      commercial: [],
      industrial: [],
    };
    for (const s of specs) {
      byKind[s.kind].push(s);
    }

    this.roofCount = 0;

    for (const kind of ['residential', 'commercial', 'industrial'] as const) {
      const mesh = this.wallsMesh.get(kind)!;
      const list = byKind[kind];
      const n = Math.min(list.length, this.capacity);

      for (let i = 0; i < n; i++) {
        const s = list[i];
        // 墙体：缩放后占地 = (w * 0.86) × h × (d * 0.86)，居中
        DUMMY.position.set(s.x + s.w / 2, 0, s.z + s.d / 2);
        DUMMY.scale.set(s.w * 0.86, s.h, s.d * 0.86);
        DUMMY.rotation.set(0, 0, 0);
        DUMMY.updateMatrix();
        mesh.setMatrixAt(i, DUMMY.matrix);
        COLOR.setHex(pickWall(kind, s.seed));
        mesh.setColorAt(i, COLOR);

        // 屋顶：略大于墙体，薄板
        DUMMY.position.set(s.x + s.w / 2, s.h, s.z + s.d / 2);
        DUMMY.scale.set(s.w * 0.86 + 0.08, 0.12, s.d * 0.86 + 0.08);
        DUMMY.updateMatrix();
        this.roofMesh.setMatrixAt(this.roofCount, DUMMY.matrix);
        COLOR.setHex(pickRoof(kind));
        this.roofMesh.setColorAt(this.roofCount, COLOR);
        this.roofCount++;
      }

      mesh.count = n;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }

    this.roofMesh.count = this.roofCount;
    this.roofMesh.instanceMatrix.needsUpdate = true;
    if (this.roofMesh.instanceColor) this.roofMesh.instanceColor.needsUpdate = true;
  }

  /** 当前总建筑数（墙体 + 屋顶 = 各类墙体之和）。 */
  getCount(): { residential: number; commercial: number; industrial: number; total: number } {
    const r = this.wallsMesh.get('residential')!.count;
    const c = this.wallsMesh.get('commercial')!.count;
    const i = this.wallsMesh.get('industrial')!.count;
    return { residential: r, commercial: c, industrial: i, total: r + c + i };
  }

  /** 当前 draw call 数（用于 HUD 参考；实际由 renderer.info 给的更准）。 */
  getDrawCallEstimate(): number {
    // 3 类墙体 + 1 类屋顶 = 4
    return 4;
  }

  /** 用于避免和 A2 老 buildings.ts 的副作用混淆。 */
  static dispose(prev: BuildingInstances): void {
    prev.group.parent?.remove(prev.group);
    prev.wallsMesh.forEach((m) => {
      m.dispose();
      (m.material as THREE.Material).dispose();
    });
    prev.roofMesh.dispose();
    (prev.roofMesh.material as THREE.Material).dispose();
  }

  // 用于消音 PALETTE 未使用 lint
  static _palette = PALETTE;
}
