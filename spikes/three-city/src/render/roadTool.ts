/**
 * 道路工具（迭代 3 · M1）
 *
 * 职责（最小切片版本）：
 *   - 维护当前激活工具：'select' | 'road' | 'bulldoze'
 *   - 在 ground 上做 raycast，拿到 tile 坐标（整数对齐 0.5 步长）
 *   - road 模式：左键按下 = 起点；拖拽 = 沿轴向（NS/EW，按 |dx| vs |dz| 决定）展开预览；
 *                松开 = 提交一段直线道路
 *   - bulldoze 模式：左键点击 = 移除该位置最近的玩家路段
 *
 * 与 sim 的对接：
 *   - 提交 / 删除时调用 onPlace / onRemove 回调
 *   - 视觉表现完全由本模块负责，sim 是否真把这条路加进 RoadGraph 由调用方决定
 *
 * 第一版有意保持简：
 *   - 不做"自动直角拼接"（玩家拖出的就是一条直线段）
 *   - 不做与已有道路的"自动 T 字交叉"（视觉上叠在一起即可，sim 端再处理拓扑）
 *   - 不做撤销栈（先专心把流程跑通）
 */

import * as THREE from 'three';

// === 公共类型 ===============================================================

export type Tool = 'select' | 'road' | 'bulldoze';

/** 玩家铺的一段道路（与 sim/traffic.RoadRegion 同形态，便于直接喂给 worker）。 */
export interface RoadSegment {
  id: number;             // 本工具内部递增 ID（与 sim 侧 parentRoadId 解耦，sim 自己再编）
  axis: 'NS' | 'EW';
  /** AABB 左下角（tile 单位） */
  x: number;
  z: number;
  /** AABB 大小（tile 单位） */
  w: number;
  d: number;
}

export interface RoadToolOptions {
  scene: THREE.Scene;
  camera: THREE.Camera;
  canvas: HTMLCanvasElement;
  /** 地面尺寸（用于裁剪鼠标命中） */
  gridW: number;
  gridD: number;
  /** 道路宽度（tile 单位，与 ROAD_WIDTH 同步）。 */
  roadWidth: number;
  /** 提交一段路时回调；返回 false 表示拒收（sim 拒绝） */
  onPlace?: (seg: RoadSegment) => boolean;
  /** 拆一段路时回调；返回 false 表示拒收 */
  onRemove?: (segId: number) => boolean;
}

// === RoadTool 实现 ==========================================================

export class RoadTool {
  private opts: RoadToolOptions;
  private current: Tool = 'select';

  // 玩家铺的所有路段（不含场景预设的井字路）。键 = id。
  private segments = new Map<number, { seg: RoadSegment; mesh: THREE.Mesh }>();
  private nextId = 1;

  // 道路与预览的视觉
  private roadGroup = new THREE.Group();
  private previewGroup = new THREE.Group();
  private roadMaterial: THREE.MeshLambertMaterial;
  private previewOk: THREE.MeshBasicMaterial;
  private previewBad: THREE.MeshBasicMaterial;
  private previewMesh: THREE.Mesh | null = null;

  // 拖拽状态
  private dragStart: { x: number; z: number } | null = null;
  private dragEnd: { x: number; z: number } | null = null;

  // raycaster
  private raycaster = new THREE.Raycaster();
  private pointerNDC = new THREE.Vector2();
  private groundPlane: THREE.Plane;

  // 监听句柄（detach 时卸）
  private onPointerDown: (e: PointerEvent) => void;
  private onPointerMove: (e: PointerEvent) => void;
  private onPointerUp: (e: PointerEvent) => void;
  private onKeyDown: (e: KeyboardEvent) => void;

  constructor(opts: RoadToolOptions) {
    this.opts = opts;
    // 地面平面 y=0，法向量朝上
    this.groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

    // 道路材质：与 ground.ts 道路条带类似的深灰
    this.roadMaterial = new THREE.MeshLambertMaterial({ color: 0x393f47 });

    // 预览：合法蓝色、非法红色，半透明
    this.previewOk = new THREE.MeshBasicMaterial({
      color: 0x6cb4ff, transparent: true, opacity: 0.55, depthWrite: false,
    });
    this.previewBad = new THREE.MeshBasicMaterial({
      color: 0xff5d4f, transparent: true, opacity: 0.55, depthWrite: false,
    });

    // 玩家路在 y=0.011（刚刚高过 ground 的预设路面 0.01）
    this.roadGroup.position.y = 0.011;
    this.previewGroup.position.y = 0.012;
    opts.scene.add(this.roadGroup);
    opts.scene.add(this.previewGroup);

    // 绑定事件（保留 this）
    this.onPointerDown = (e) => this.handlePointerDown(e);
    this.onPointerMove = (e) => this.handlePointerMove(e);
    this.onPointerUp = (e) => this.handlePointerUp(e);
    this.onKeyDown = (e) => this.handleKey(e);

    opts.canvas.addEventListener('pointerdown', this.onPointerDown);
    opts.canvas.addEventListener('pointermove', this.onPointerMove);
    opts.canvas.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('keydown', this.onKeyDown);
  }

  detach(): void {
    const c = this.opts.canvas;
    c.removeEventListener('pointerdown', this.onPointerDown);
    c.removeEventListener('pointermove', this.onPointerMove);
    c.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('keydown', this.onKeyDown);
  }

  setTool(t: Tool): void {
    if (this.current === t) return;
    this.current = t;
    this.cancelDrag();
    this.opts.canvas.style.cursor = t === 'road' ? 'crosshair'
      : t === 'bulldoze' ? 'not-allowed' : 'default';
  }

  getTool(): Tool { return this.current; }

  /** 暴露给 sim/外部：玩家路段总数。 */
  size(): number { return this.segments.size; }

  // === 鼠标 / 键盘 =========================================================

  private handlePointerDown(e: PointerEvent): void {
    // 右键交给相机；只处理左键
    if (e.button !== 0) return;
    if (this.current === 'select') return;
    e.stopPropagation();
    e.preventDefault();

    const hit = this.pickGround(e);
    if (!hit) return;

    if (this.current === 'road') {
      this.dragStart = hit;
      this.dragEnd = hit;
      this.updatePreview();
    } else if (this.current === 'bulldoze') {
      this.tryRemoveAt(hit.x, hit.z);
    }
  }

  private handlePointerMove(e: PointerEvent): void {
    if (this.current !== 'road' || !this.dragStart) return;
    const hit = this.pickGround(e);
    if (!hit) return;
    this.dragEnd = hit;
    this.updatePreview();
  }

  private handlePointerUp(e: PointerEvent): void {
    if (e.button !== 0) return;
    if (this.current !== 'road' || !this.dragStart || !this.dragEnd) return;
    e.stopPropagation();

    const seg = this.computeSegment(this.dragStart, this.dragEnd);
    this.cancelDrag();
    if (!seg) return;
    if (!this.canPlace(seg)) return;
    this.commitSegment(seg);
  }

  private handleKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      this.cancelDrag();
    }
  }

  // === 拾取 / 几何 =========================================================

  private pickGround(e: PointerEvent): { x: number; z: number } | null {
    const rect = this.opts.canvas.getBoundingClientRect();
    this.pointerNDC.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointerNDC.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointerNDC, this.opts.camera);
    const out = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(this.groundPlane, out)) return null;
    // 裁剪到地图边界，避免越界
    const x = Math.max(0, Math.min(this.opts.gridW, out.x));
    const z = Math.max(0, Math.min(this.opts.gridD, out.z));
    // 0.5 step 对齐
    return { x: Math.round(x * 2) / 2, z: Math.round(z * 2) / 2 };
  }

  private computeSegment(a: { x: number; z: number }, b: { x: number; z: number }): RoadSegment | null {
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    if (Math.abs(dx) < 0.5 && Math.abs(dz) < 0.5) return null;
    const w = this.opts.roadWidth;
    if (Math.abs(dx) >= Math.abs(dz)) {
      // EW 走向（x 方向延伸）
      const x0 = Math.min(a.x, b.x);
      const x1 = Math.max(a.x, b.x);
      const cz = a.z;          // 用起点的 z 当中线（实际上拖到哪里都按起点中线）
      return {
        id: this.nextId,
        axis: 'EW',
        x: x0,
        z: cz - w / 2,
        w: x1 - x0,
        d: w,
      };
    } else {
      const z0 = Math.min(a.z, b.z);
      const z1 = Math.max(a.z, b.z);
      const cx = a.x;
      return {
        id: this.nextId,
        axis: 'NS',
        x: cx - w / 2,
        z: z0,
        w,
        d: z1 - z0,
      };
    }
  }

  private canPlace(seg: RoadSegment): boolean {
    // 不出地图
    if (seg.x < 0 || seg.z < 0) return false;
    if (seg.x + seg.w > this.opts.gridW) return false;
    if (seg.z + seg.d > this.opts.gridD) return false;
    if (seg.w < 0.5 || seg.d < 0.5) return false;
    // 长度太短的也不收
    if (seg.axis === 'EW' && seg.w < 1.5) return false;
    if (seg.axis === 'NS' && seg.d < 1.5) return false;
    return true;
  }

  // === 视觉 ================================================================

  private updatePreview(): void {
    if (!this.dragStart || !this.dragEnd) return;
    const seg = this.computeSegment(this.dragStart, this.dragEnd);
    this.clearPreview();
    if (!seg) return;
    const ok = this.canPlace(seg);
    const mat = ok ? this.previewOk : this.previewBad;
    this.previewMesh = this.makeRoadMesh(seg, mat);
    this.previewGroup.add(this.previewMesh);
  }

  private clearPreview(): void {
    if (this.previewMesh) {
      this.previewGroup.remove(this.previewMesh);
      this.previewMesh.geometry.dispose();
      this.previewMesh = null;
    }
  }

  private cancelDrag(): void {
    this.dragStart = null;
    this.dragEnd = null;
    this.clearPreview();
  }

  private commitSegment(seg: RoadSegment): void {
    seg.id = this.nextId++;
    if (this.opts.onPlace && !this.opts.onPlace(seg)) {
      // sim 端拒绝，不渲染
      return;
    }
    const mesh = this.makeRoadMesh(seg, this.roadMaterial);
    this.roadGroup.add(mesh);
    this.segments.set(seg.id, { seg, mesh });
  }

  private tryRemoveAt(x: number, z: number): void {
    // 找到包含该点的玩家路段
    let target: { id: number; mesh: THREE.Mesh } | null = null;
    for (const { seg, mesh } of this.segments.values()) {
      if (x >= seg.x && x < seg.x + seg.w && z >= seg.z && z < seg.z + seg.d) {
        target = { id: seg.id, mesh };
        break;
      }
    }
    if (!target) return;
    if (this.opts.onRemove && !this.opts.onRemove(target.id)) return;
    target.mesh.geometry.dispose();
    this.roadGroup.remove(target.mesh);
    this.segments.delete(target.id);
  }

  private makeRoadMesh(seg: RoadSegment, mat: THREE.Material): THREE.Mesh {
    const geom = new THREE.PlaneGeometry(seg.w, seg.d);
    geom.rotateX(-Math.PI / 2);
    geom.translate(seg.x + seg.w / 2, 0, seg.z + seg.d / 2);
    return new THREE.Mesh(geom, mat);
  }
}
