/**
 * 道路拥堵热力图（E1 · 支持 per-edge / per-parent 双模式）
 *
 * 思路：
 *   - 仍是每段路一个独立 Mesh（C3 一致）
 *   - 但 region 列表现在可以是"父路 4 条"或"子边 12 条"
 *   - 颜色由 congestion 决定：绿（0）→ 黄（0.5）→ 红（1）
 *
 * 数据来源：
 *   - 父路模式：SimSnapshot.roads 仍是 [flow, cong] × 4
 *   - 子边模式：SimSnapshot.edges 是 [flow, cong] × N（E1 新增）
 *
 * 渲染层不感知图结构，只接受 region 矩形 + 一个匹配的数据流。
 */

import * as THREE from 'three';

const COLOR_LO = new THREE.Color(0x7ed085);   // 通畅 绿
const COLOR_MD = new THREE.Color(0xfdd06a);   // 中等 黄
const COLOR_HI = new THREE.Color(0xff5d4f);   // 拥堵 红

const TMP = new THREE.Color();

function lerpColor(out: THREE.Color, a: THREE.Color, b: THREE.Color, t: number): void {
  out.r = a.r + (b.r - a.r) * t;
  out.g = a.g + (b.g - a.g) * t;
  out.b = a.b + (b.b - a.b) * t;
}

function congestionToColor(c: number, out: THREE.Color): void {
  if (c <= 0.5) {
    lerpColor(out, COLOR_LO, COLOR_MD, c / 0.5);
  } else {
    lerpColor(out, COLOR_MD, COLOR_HI, (c - 0.5) / 0.5);
  }
}

export interface RoadVisualRegion {
  x: number;
  z: number;
  w: number;
  d: number;
}

export class RoadHeatmap {
  readonly group: THREE.Group;
  private meshes: THREE.Mesh[] = [];
  private materials: THREE.MeshBasicMaterial[] = [];

  constructor(regions: RoadVisualRegion[]) {
    this.group = new THREE.Group();
    this.rebuild(regions);
  }

  /** 在初始化或拓扑变化后重建 mesh 列表。 */
  rebuild(regions: RoadVisualRegion[]): void {
    // 清掉旧 mesh
    for (const m of this.meshes) {
      this.group.remove(m);
      (m.geometry as THREE.BufferGeometry).dispose();
    }
    for (const mat of this.materials) mat.dispose();
    this.meshes.length = 0;
    this.materials.length = 0;

    for (const r of regions) {
      const mat = new THREE.MeshBasicMaterial({
        color: COLOR_LO,
        transparent: true,
        opacity: 0.55,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(r.w, r.d), mat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.set(r.x + r.w / 2, 0.025, r.z + r.d / 2);
      this.group.add(mesh);
      this.meshes.push(mesh);
      this.materials.push(mat);
    }
  }

  /** packed = [flow0, cong0, flow1, cong1, ...] */
  apply(packed: Float32Array): void {
    const n = Math.min(this.materials.length, packed.length >> 1);
    for (let r = 0; r < n; r++) {
      const cong = packed[r * 2 + 1];
      congestionToColor(cong, TMP);
      this.materials[r].color.copy(TMP);
      this.materials[r].opacity = 0.45 + cong * 0.35;
    }
  }

  setVisible(v: boolean): void {
    this.group.visible = v;
  }
}
