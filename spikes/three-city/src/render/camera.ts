/**
 * 正交相机控制器（A2 探针）
 *
 * 提供：
 *   - 围绕 pivot 的水平旋转（按住右键 / 方向键 ←→）
 *   - 缩放（鼠标滚轮，改 viewSize）
 *   - 平移留给 C 阶段做（spike 阶段先聚焦评审画面）
 *
 * 镜头基线：东南 45° 俯视，模拟 SimCity / 城市天际线像素化版本的常见视角
 */

import * as THREE from 'three';

export interface CameraOptions {
  pivot: THREE.Vector3;
  viewSize: number;
  minViewSize: number;
  maxViewSize: number;
}

export class OrthoCityCamera {
  readonly camera: THREE.OrthographicCamera;
  private pivot: THREE.Vector3;
  private viewSize: number;
  private azimuth: number = Math.PI / 4;   // 水平角（默认东南 45°）
  private elevation: number = Math.PI / 6; // 俯仰角（默认 30°，保留 2.5D 视感）
  private distance: number = 30;           // 相机到 pivot 的距离（正交相机其实不影响透视，但用于 lookAt）
  private opts: CameraOptions;

  // 交互状态
  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  /** 迭代 3：当工具占用左键时（铺路 / 拆除），关闭相机的左键拖拽。 */
  private leftButtonEnabled = true;

  setLeftButtonEnabled(v: boolean): void {
    this.leftButtonEnabled = v;
    if (!v && this.dragging) this.dragging = false;
  }

  constructor(opts: CameraOptions) {
    this.opts = opts;
    this.pivot = opts.pivot.clone();
    this.viewSize = opts.viewSize;
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 200);
    this.updateMatrix();
  }

  attach(canvas: HTMLCanvasElement): void {
    canvas.addEventListener('pointerdown', this.onDown);
    canvas.addEventListener('pointermove', this.onMove);
    canvas.addEventListener('pointerup', this.onUp);
    canvas.addEventListener('pointercancel', this.onUp);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    window.addEventListener('keydown', this.onKey);
  }

  resize(screenW: number, screenH: number): void {
    const aspect = screenW / screenH;
    this.camera.left = -this.viewSize * aspect;
    this.camera.right = this.viewSize * aspect;
    this.camera.top = this.viewSize;
    this.camera.bottom = -this.viewSize;
    this.camera.updateProjectionMatrix();
  }

  private updateMatrix(): void {
    const x = this.pivot.x + this.distance * Math.cos(this.elevation) * Math.cos(this.azimuth);
    const y = this.pivot.y + this.distance * Math.sin(this.elevation);
    const z = this.pivot.z + this.distance * Math.cos(this.elevation) * Math.sin(this.azimuth);
    this.camera.position.set(x, y, z);
    this.camera.lookAt(this.pivot);
  }

  private onDown = (e: PointerEvent): void => {
    // 左键被工具占用时不接管
    if (e.button === 0 && !this.leftButtonEnabled) return;
    if (e.button !== 2 && e.button !== 0) return;
    this.dragging = true;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };

  private onMove = (e: PointerEvent): void => {
    if (!this.dragging) return;
    const dx = e.clientX - this.lastX;
    const dy = e.clientY - this.lastY;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    this.azimuth += dx * 0.008;
    this.elevation = Math.max(0.12, Math.min(Math.PI / 2 - 0.05, this.elevation - dy * 0.005));
    this.updateMatrix();
  };

  private onUp = (e: PointerEvent): void => {
    this.dragging = false;
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch { /* ignore */ }
  };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const factor = Math.exp(e.deltaY * 0.001);
    this.viewSize = Math.max(this.opts.minViewSize, Math.min(this.opts.maxViewSize, this.viewSize * factor));
    this.resize(window.innerWidth, window.innerHeight);
  };

  private onKey = (e: KeyboardEvent): void => {
    if (e.key === 'ArrowLeft') { this.azimuth -= 0.08; this.updateMatrix(); }
    else if (e.key === 'ArrowRight') { this.azimuth += 0.08; this.updateMatrix(); }
    else if (e.key === 'ArrowUp') { this.elevation = Math.min(Math.PI / 2 - 0.05, this.elevation + 0.05); this.updateMatrix(); }
    else if (e.key === 'ArrowDown') { this.elevation = Math.max(0.12, this.elevation - 0.05); this.updateMatrix(); }
  };

  getViewSize(): number { return this.viewSize; }
  getAzimuthDeg(): number { return ((this.azimuth * 180 / Math.PI) % 360 + 360) % 360; }
  getElevationDeg(): number { return this.elevation * 180 / Math.PI; }
}
