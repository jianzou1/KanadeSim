/**
 * 代理可视化（迭代 2 收尾 · 进出门用淡入/淡出取代瞬隐瞬现）
 *
 * 设计：
 *   - walker（步行）：立方块，慢
 *   - driver（驾车）：扁车形，快
 *   - 渲染策略：
 *       - GoingToWork / GoingHome：正常渲染
 *       - 刚切到 GoingToWork/GoingHome（出门）：320ms 缩放淡入
 *       - 刚到达切到 Working/AtHome（进门）：320ms 缩放淡出（仍渲染，scale 1→0.2）
 *       - 已稳定 Working/AtHome：彻底不渲染
 *   - 60Hz 双缓冲插值保留
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

/** 迭代 3 C3：货车按 truckPhase 着色（运货中=亮黄，空载=暗蓝） */
const TRUCK_COLOR_LOADED = 0xffce4a;
const TRUCK_COLOR_EMPTY = 0x7a8aa0;

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
    // 关闭 frustum culling：InstancedMesh 的 boundingSphere 默认按"模板几何"算，
    // 不反映实例分布。镜头推进时 boundingSphere 容易整体落到视椎外 → 全部剔除，
    // 表现为"行人车辆突然不可见"。spike 阶段 1k-2k 实例不剔除也无性能压力。
    this.mesh.frustumCulled = false;
  }
}

// 视觉可见状态：在路上才渲染
// 迭代 3 C3：货车（kind=Truck）永远可见（不走 state 机制）
function isVisibleState(s: number, kind?: number): boolean {
  if (kind === AgentKind.Truck) return true;
  return s === AgentState.GoingToWork || s === AgentState.GoingHome;
}

// 出现淡入时长（毫秒）。让"刚出门的代理"从透明 lerp 到不透明，
// 避免视觉上"凭空出现在起点"的瞬移感。
const APPEAR_FADE_MS = 320;

// 消失淡出时长（毫秒）。代理到达终点 state 切到 Working/AtHome 时，
// 渲染端再保留这么长时间，scale 从 1 → 0.2 渐变，避免"瞬间消失"。
const DISAPPEAR_FADE_MS = 320;

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
  /** 上一份快照时该代理的 state，用于检测"隐藏→可见"边沿。 */
  private prevState: Uint8Array;
  /** 该代理首次进入可见态的时间戳（performance.now），用于淡入。0 = 不在淡入中或长期可见。 */
  private appearedAt: Float32Array;
  /** 该代理刚切到不可见态的时间戳（performance.now），用于淡出。0 = 不在淡出中。 */
  private disappearingAt: Float32Array;
  /** 淡出时锁定的位置（消失瞬间的 sim 位置），让淡出过程不再随 sim 变化。 */
  private fadeOutX: Float32Array;
  private fadeOutZ: Float32Array;
  private fadeOutKind: Uint8Array;
  /** 淡出代理在消失前的 state（决定颜色），淡出时 currState 已切走，要单独存。 */
  private fadeOutState: Uint8Array;
  private activeCount = 0;

  // 插值时基
  private snapReceivedAt = 0;
  /** 上一次收到 snapshot 与上上次的实际间隔（ms），用作 lerp 分母。 */
  private snapIntervalMs = TICK_MS;
  private hasFirstSnap = false;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.prevX = new Float32Array(capacity);
    this.prevZ = new Float32Array(capacity);
    this.currX = new Float32Array(capacity);
    this.currZ = new Float32Array(capacity);
    this.currState = new Uint8Array(capacity);
    this.currKind = new Uint8Array(capacity);
    this.prevState = new Uint8Array(capacity);
    this.appearedAt = new Float32Array(capacity);
    this.disappearingAt = new Float32Array(capacity);
    this.fadeOutX = new Float32Array(capacity);
    this.fadeOutZ = new Float32Array(capacity);
    this.fadeOutKind = new Uint8Array(capacity);
    this.fadeOutState = new Uint8Array(capacity);

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
    const now = performance.now();

    // 重生：新代理来源完全变了，prev 直接 = 新位置（避免从旧位置 lerp 到新位置 = 瞬移视感）
    const treatAsRespawn = respawned || !this.hasFirstSnap;

    if (!treatAsRespawn) {
      // 正常帧：把当前作为上一帧
      this.prevX.set(this.currX.subarray(0, this.activeCount));
      this.prevZ.set(this.currZ.subarray(0, this.activeCount));
      // prevState 也要保留，作为本次"边沿检测"的基准
      this.prevState.set(this.currState.subarray(0, this.activeCount));
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
      this.prevState.set(this.currState.subarray(0, n));
      // 重生帧里所有"已经可见"的代理都视为刚出现，给一次淡入
      for (let i = 0; i < n; i++) {
        this.appearedAt[i] = isVisibleState(this.currState[i], this.currKind[i]) ? now : 0;
        this.disappearingAt[i] = 0;
      }
      this.hasFirstSnap = true;
    } else {
      // 正常帧：检查"隐藏 → 可见"和"可见 → 隐藏"的状态边沿
      // 这是 C3.3 之后剩下的"瞬移"主因——代理在 AtHome 时不渲染，状态切到 GoingToWork
      // 那一帧才出现，prev[i] 还是它"在公司里"的旧位置，alpha lerp 会让它从旧坐标
      // 飞到家门口。修复：边沿出现时强制 prev = curr，并启动淡入。
      // 同样地，到达 work 时 GoingToWork→Working 那一帧瞬隐，需要锁定一份"消失瞬间"
      // 的位置 + 启动淡出。
      for (let i = 0; i < n; i++) {
        const wasVisible = isVisibleState(this.prevState[i], this.currKind[i]);
        const nowVisible = isVisibleState(this.currState[i], this.currKind[i]);
        if (!wasVisible && nowVisible) {
          // 刚出门：钉死起点，避免从旧位置插过来
          this.prevX[i] = this.currX[i];
          this.prevZ[i] = this.currZ[i];
          this.appearedAt[i] = now;
          this.disappearingAt[i] = 0;     // 出门即取消任何挂着的淡出
        } else if (wasVisible && !nowVisible) {
          // 进门：锁定"消失瞬间"的位置 + 当时的 kind / state，启动淡出
          // 注意：currX/Z 是 sim 端到达后停的位置（work/home 中心），用它作终点
          this.fadeOutX[i] = this.currX[i];
          this.fadeOutZ[i] = this.currZ[i];
          this.fadeOutKind[i] = this.currKind[i];
          this.fadeOutState[i] = this.prevState[i];     // 用 prev 的颜色（GoingToWork/GoingHome）
          this.disappearingAt[i] = now;
          this.appearedAt[i] = 0;
        }
      }
      // 兜底：n 增长时，新增的索引按重生处理
      if (n > this.activeCount) {
        for (let i = this.activeCount; i < n; i++) {
          this.prevX[i] = this.currX[i];
          this.prevZ[i] = this.currZ[i];
          this.appearedAt[i] = isVisibleState(this.currState[i], this.currKind[i]) ? now : 0;
          this.disappearingAt[i] = 0;
        }
      }
    }

    this.activeCount = n;
    // 用"上一份 snap 到本份 snap"的真实间隔做 lerp 分母，自动适配倍速：
    //   1x 下 ≈ 250ms，4x 下 ≈ 62.5ms。固定 TICK_MS 会让倍速下 3/4 时间停在 curr，
    //   视觉上像"走一下停一下"，叠加交叉口的几何跳变会被误读成"反复抽搐"。
    if (this.snapReceivedAt > 0) {
      const dt = now - this.snapReceivedAt;
      // 极端值兜底：worker 卡顿时不让分母爆炸
      this.snapIntervalMs = dt > 0 && dt < 5000 ? dt : TICK_MS;
    }
    this.snapReceivedAt = now;
  }

  /** 每帧渲染调用：根据距离上次 snap 的时间算 alpha，做插值。 */
  renderTick(now: number): void {
    if (!this.hasFirstSnap) return;

    // alpha 严格 clamp 到 [0, 1]：超过 1 不再外推（曾经允许 1.2，会让代理"冲过 curr 再
    // 被下一份快照拉回"，视觉上像在终点 / 交叉口反复抽搐）。worker 快照间隔不稳的代价
    // 转嫁给"短暂停在 curr"，比反向位移好看得多。
    // 用真实 snapIntervalMs 而非固定 TICK_MS 做分母，自动适配倍速。
    const raw = (now - this.snapReceivedAt) / Math.max(16, this.snapIntervalMs);
    const alpha = raw < 0 ? 0 : raw > 1 ? 1 : raw;

    const n = this.activeCount;
    let walkerCount = 0;
    let driverCount = 0;

    for (let i = 0; i < n; i++) {
      const st = this.currState[i];
      const k = this.currKind[i];
      const visible = isVisibleState(st, k);

      // 淡出态：sim 端已切到 Working/AtHome，但视觉上还要保留 DISAPPEAR_FADE_MS
      const fadingOut = !visible && this.disappearingAt[i] > 0;
      if (!visible && !fadingOut) continue;

      let x: number, z: number;
      let kind: number;
      let stateForColor: number;
      let scale = 1;

      if (fadingOut) {
        const elapsed = now - this.disappearingAt[i];
        if (elapsed >= DISAPPEAR_FADE_MS) {
          this.disappearingAt[i] = 0;
          continue;     // 淡出完成，彻底不渲染
        }
        // 锁定到消失瞬间的位置 + kind + state，scale 1 → 0.2 smoothstep
        x = this.fadeOutX[i];
        z = this.fadeOutZ[i];
        kind = this.fadeOutKind[i];
        stateForColor = this.fadeOutState[i];
        const t = elapsed / DISAPPEAR_FADE_MS;
        scale = 1 - (1 - 0.2) * (t * t * (3 - 2 * t));
      } else {
        // 正常 lerp 插值
        x = this.prevX[i] + (this.currX[i] - this.prevX[i]) * alpha;
        z = this.prevZ[i] + (this.currZ[i] - this.prevZ[i]) * alpha;
        kind = this.currKind[i];
        stateForColor = st;

        // 出门淡入：缩放从 0.2 → 1.0
        const appearedAt = this.appearedAt[i];
        if (appearedAt > 0) {
          const elapsed = now - appearedAt;
          if (elapsed < APPEAR_FADE_MS) {
            const t = elapsed / APPEAR_FADE_MS;
            scale = 0.2 + (1 - 0.2) * (t * t * (3 - 2 * t));
          } else {
            this.appearedAt[i] = 0;
          }
        }
      }

      DUMMY.position.set(x, 0, z);

      if (kind === AgentKind.Driver || kind === AgentKind.Truck) {
        // 车按运动方向旋转（用 prev → curr 的方向，比 vx/vz 干净）
        const dx = this.currX[i] - this.prevX[i];
        const dz = this.currZ[i] - this.prevZ[i];
        const yaw = Math.atan2(dx, dz);
        DUMMY.rotation.set(0, yaw, 0);
      } else {
        DUMMY.rotation.set(0, 0, 0);
      }
      DUMMY.scale.set(scale, scale, scale);
      DUMMY.updateMatrix();

      const layer = (kind === AgentKind.Driver || kind === AgentKind.Truck) ? this.driver : this.walker;
      const slot = (kind === AgentKind.Driver || kind === AgentKind.Truck) ? driverCount++ : walkerCount++;

      layer.mesh.setMatrixAt(slot, DUMMY.matrix);
      let hex: number;
      if (kind === AgentKind.Truck) {
        // 货车颜色：满载亮黄，空载暗蓝（由 stateForColor 的 hack：sim 端 truck state 永远 AtHome，
        // V0 简化：先全按 LOADED 显示；V1 通过 stateForColor 区分 Loading/GoToDst 等）
        hex = TRUCK_COLOR_LOADED;
      } else {
        const palette = kind === AgentKind.Driver ? STATE_COLORS_DRIVE : STATE_COLORS_WALK;
        hex = palette[stateForColor] ?? 0xffffff;
      }
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
