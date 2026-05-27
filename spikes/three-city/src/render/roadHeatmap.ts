/**
 * 道路拥堵热力图（C3 · design.md §8 档 1）
 *
 * 思路：
 *   - 给每段路一个独立的 PlaneGeometry mesh，颜色由 congestion 决定
 *   - 平铺在原沥青上方 0.005 处（z-fight 安全余量）
 *   - 拥堵度 0→1 渐变：绿（0）→ 黄（0.5）→ 红（1）
 *   - 用 Mesh + MeshBasicMaterial（自发光，不受光照影响，颜色稳定）
 *
 * 数据来源：SimSnapshot.roads（[flow, congestion] × N），主线程每帧读最新一份
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
  // 0~0.5 绿→黄；0.5~1 黄→红
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
    for (const r of regions) {
      // 半透明叠色到沥青上，保留原沥青纹理可读性
      const mat = new THREE.MeshBasicMaterial({
        color: COLOR_LO,
        transparent: true,
        opacity: 0.55,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(r.w, r.d), mat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.set(r.x + r.w / 2, 0.025, r.z + r.d / 2);  // 在道路（0.01）上方一点
      this.group.add(mesh);
      this.meshes.push(mesh);
      this.materials.push(mat);
    }
  }

  /** roadsPacked = [flow0, cong0, flow1, cong1, ...] */
  apply(roadsPacked: Float32Array): void {
    const n = Math.min(this.materials.length, roadsPacked.length >> 1);
    for (let r = 0; r < n; r++) {
      const cong = roadsPacked[r * 2 + 1];
      congestionToColor(cong, TMP);
      this.materials[r].color.copy(TMP);
      // 拥堵高的路也更醒目（不透明度小幅增加）
      this.materials[r].opacity = 0.45 + cong * 0.35;
    }
  }

  setVisible(v: boolean): void {
    this.group.visible = v;
  }
}
