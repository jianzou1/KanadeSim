/**
 * 代理可视化（C3.2 · walker / driver 分类 + 仅渲染在途）
 *
 * 设计：
 *   - walker（步行）：立方块，慢
 *   - driver（驾车）：扁车形，快
 *   - 仅渲染 state ∈ {GoingToWork, GoingHome} 的代理；在家/在公司的隐藏（mesh.count 调小）
 *   - 60Hz 插值（B1 补丁的 prev/curr）保留
 *
 * 性能：两个 InstancedMesh 各管一类 = +1 draw call，仍在富裕区间
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { AgentState, AgentKind, AGENT_STRIDE, TICK_MS, type SimSnapshot } from '../sim/types';

const DUMMY = new THREE.Object3D();
const COLOR = new THREE.Color();

const STATE_COLORS_WALK: Record<number, number> = {
  [AgentState.GoingToWork]: 0xfdd06a,    // 黄
  [AgentState.GoingHome]: 0xff9a55,      // 橙
};

const STATE_COLORS_DRIVE: Record<number, number> = {
  [AgentState.GoingToWork]: 0x6cd0ff,    // 浅蓝（车）
  [AgentState.GoingHome]: 0xc77bff,      // 紫（车）
};

class InstanceLayer {
  readonly mesh: THREE.InstancedMesh;
  count = 0;
  constructor(geom: THREE.BufferGeometry, capacity: number) {
    const mat = new THREE.MeshLambertMaterial({ flatShading: true });
    this.mesh = new THREE.InstancedMesh(geom, mat, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(capacity * 3),
      3,
    );
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
  }
}

export class AgentInstances {
  readonly walker: InstanceLayer;
  readonly driver: InstanceLayer;
  private capacity: number;

  // 双缓冲：上一份快照位置 + 当前快照位置
  private prevX: Float32Array;
  private prevZ: Float32Array;
  private currX: Float32Array;
  private currZ: Float32Array;
  private currState: Uint8Array;
  private currKind: Uint8Array;
  private activeCount = 0;

  // 插值时基
  private snapReceivedAt = 0;
  private hasFirstSnap = false;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.prevX = new Float32Array(capacity);
    this.prevZ = new Float32Array(capacity);
    this.currX = new Float32Array(capacity);
    this.currZ = new Float32Array(capacity);
    this.currState = new Uint8Array(capacity);
    this.currKind = new Uint8Array(capacity);

    // 步行：立方块（高一点更像人）
    const walkerGeom = new THREE.BoxGeometry(0.22, 0.45, 0.22);
    walkerGeom.translate(0, 0.225, 0);

    // 车：明显比步行更大，扁宽 + 一个顶部小盒子做"车顶"
    // 用合并几何让"车身 + 车顶"作为一个实例
    const driverGeom = makeCarGeometry();

    this.walker = new InstanceLayer(walkerGeom, capacity);
    this.driver = new InstanceLayer(driverGeom, capacity);
  }

  /** 收到新快照：把 curr 拷到 prev，新快照写入 curr，重置时基。 */
  ingestSnapshot(snap: SimSnapshot): void {
    const { agents, activeAgents, respawned } = snap;
    const n = Math.min(activeAgents, this.capacity);

    // 重生：新代理来源完全变了，prev 直接 = 新位置（避免从旧位置 lerp 到新位置 = 瞬移视感）
    const treatAsRespawn = respawned || !this.hasFirstSnap;

    if (!treatAsRespawn) {
      // 正常帧：把当前作为上一帧
      this.prevX.set(this.currX.subarray(0, this.activeCount));
      this.prevZ.set(this.currZ.subarray(0, this.activeCount));
    }

    for (let i = 0; i < n; i++) {
      const o = i * AGENT_STRIDE;
      this.currX[i] = agents[o];
      this.currZ[i] = agents[o + 1];
      this.currState[i] = agents[o + 2] | 0;
      this.currKind[i] = agents[o + 3] | 0;
    }

    if (treatAsRespawn) {
      // prev = curr，alpha 任意值都不会产生位移
      this.prevX.set(this.currX.subarray(0, n));
      this.prevZ.set(this.currZ.subarray(0, n));
      this.hasFirstSnap = true;
    } else if (n > this.activeCount) {
      // 新增的代理（理论上 respawned=false 时不会发生，但兜底）
      this.prevX.set(this.currX.subarray(this.activeCount, n), this.activeCount);
      this.prevZ.set(this.currZ.subarray(this.activeCount, n), this.activeCount);
    }

    this.activeCount = n;
    this.snapReceivedAt = performance.now();
  }

  /** 每帧渲染调用：根据距离上次 snap 的时间算 alpha，做插值。 */
  renderTick(now: number): void {
    if (!this.hasFirstSnap) return;

    const raw = (now - this.snapReceivedAt) / TICK_MS;
    const alpha = raw < 0 ? 0 : raw > 1.2 ? 1 : raw;

    const n = this.activeCount;
    let walkerCount = 0;
    let driverCount = 0;

    for (let i = 0; i < n; i++) {
      const st = this.currState[i];
      // 仅渲染"在路上"的：到家/在公司的隐藏（车进了建筑就消失）
      if (st !== AgentState.GoingToWork && st !== AgentState.GoingHome) continue;

      const x = this.prevX[i] + (this.currX[i] - this.prevX[i]) * alpha;
      const z = this.prevZ[i] + (this.currZ[i] - this.prevZ[i]) * alpha;
      DUMMY.position.set(x, 0, z);

      if (this.currKind[i] === AgentKind.Driver) {
        // 车按运动方向旋转（用 prev → curr 的方向，比 vx/vz 干净）
        const dx = this.currX[i] - this.prevX[i];
        const dz = this.currZ[i] - this.prevZ[i];
        const yaw = Math.atan2(dx, dz);
        DUMMY.rotation.set(0, yaw, 0);
      } else {
        DUMMY.rotation.set(0, 0, 0);
      }
      DUMMY.updateMatrix();

      const layer = this.currKind[i] === AgentKind.Driver ? this.driver : this.walker;
      const slot = this.currKind[i] === AgentKind.Driver ? driverCount++ : walkerCount++;

      layer.mesh.setMatrixAt(slot, DUMMY.matrix);
      const palette = this.currKind[i] === AgentKind.Driver ? STATE_COLORS_DRIVE : STATE_COLORS_WALK;
      const hex = palette[st] ?? 0xffffff;
      COLOR.setHex(hex);
      layer.mesh.setColorAt(slot, COLOR);
    }

    this.walker.mesh.count = walkerCount;
    this.driver.mesh.count = driverCount;
    this.walker.mesh.instanceMatrix.needsUpdate = true;
    this.driver.mesh.instanceMatrix.needsUpdate = true;
    if (this.walker.mesh.instanceColor) this.walker.mesh.instanceColor.needsUpdate = true;
    if (this.driver.mesh.instanceColor) this.driver.mesh.instanceColor.needsUpdate = true;
  }

  /** 把两个 mesh 都加进 scene。 */
  addToScene(scene: THREE.Scene): void {
    scene.add(this.walker.mesh);
    scene.add(this.driver.mesh);
  }
}

/**
 * 程序化生成一辆"车"的合并几何：车身（大盒子）+ 车顶（小盒子）。
 * 朝向：车头沿 +Z 方向（z[i] 增加 = 前进方向），与 yaw=atan2(dx, dz) 一致
 *
 * 尺寸（C3.3 加大）：
 *   车身  长 0.95 × 高 0.32 × 宽 0.45
 *   车顶  长 0.55 × 高 0.18 × 宽 0.40，offset to body front-half
 */
function makeCarGeometry(): THREE.BufferGeometry {
  const body = new THREE.BoxGeometry(0.45, 0.32, 0.95);
  body.translate(0, 0.16, 0);

  const cabin = new THREE.BoxGeometry(0.40, 0.18, 0.55);
  cabin.translate(0, 0.32 + 0.09, -0.08);    // 略偏后做出"驾驶舱"感

  const merged = mergeGeometries([body, cabin]);
  if (!merged) {
    // 兜底：合并失败就只用车身
    return body;
  }
  body.dispose();
  cabin.dispose();
  return merged;
}
