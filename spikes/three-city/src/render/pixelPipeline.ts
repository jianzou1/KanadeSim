/**
 * 像素化渲染管线（A2 探针核心）
 *
 * 思路（design.md §3 推荐路径）：
 *   1. 场景渲染到一个低分辨率 RenderTarget（如 480×270）
 *   2. 用一个全屏 quad，把 RT 内容用 nearest filter 放大到屏幕尺寸
 *   3. 浏览器层面再叠一层 CSS image-rendering: pixelated 兜底
 *
 * 优点：
 *   - 不引入 EffectComposer / postprocessing 包，零额外依赖
 *   - 渲染负载随 RT 分辨率线性下降，B2 压测时可调 pixelScale 验证 GPU 余量
 *   - 像素边缘干净，无 AA 模糊
 *
 * 可选扩展（A2 阶段不上，但留接口）：
 *   - color quantization shader（减色到 32/64 色，更像素）
 *   - dithering（Bayer 4x4）
 */

import * as THREE from 'three';

export interface PixelPipelineOptions {
  /** 一个像素 = 屏幕上几个像素，越大越像素化，建议 2-4。 */
  pixelScale: number;
  /** 是否启用颜色量化（减色）。 */
  quantize?: boolean;
  /** 量化级别，每通道几级（4=64 色，8=512 色），quantize=true 时生效。 */
  quantizeLevels?: number;
}

export class PixelPipeline {
  private renderer: THREE.WebGLRenderer;
  private rt!: THREE.WebGLRenderTarget;
  private fsScene: THREE.Scene;
  private fsCamera: THREE.OrthographicCamera;
  private fsQuad: THREE.Mesh;
  private fsMaterial: THREE.ShaderMaterial;
  private options: Required<PixelPipelineOptions>;

  constructor(renderer: THREE.WebGLRenderer, options: PixelPipelineOptions) {
    this.renderer = renderer;
    this.options = {
      pixelScale: options.pixelScale,
      quantize: options.quantize ?? false,
      quantizeLevels: options.quantizeLevels ?? 6,
    };

    // 创建初始 RT（resize 时重建）
    this.rt = this.makeRT(1, 1);

    // 全屏 quad 场景
    this.fsScene = new THREE.Scene();
    this.fsCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    this.fsMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: this.rt.texture },
        uQuantize: { value: this.options.quantize ? 1.0 : 0.0 },
        uLevels: { value: this.options.quantizeLevels },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D tDiffuse;
        uniform float uQuantize;
        uniform float uLevels;
        varying vec2 vUv;

        vec3 quantize(vec3 c, float levels) {
          return floor(c * levels + 0.5) / levels;
        }

        void main() {
          vec4 c = texture2D(tDiffuse, vUv);
          if (uQuantize > 0.5) {
            c.rgb = quantize(c.rgb, uLevels);
          }
          gl_FragColor = c;
        }
      `,
      depthTest: false,
      depthWrite: false,
    });

    this.fsQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.fsMaterial);
    this.fsScene.add(this.fsQuad);
  }

  private makeRT(w: number, h: number): THREE.WebGLRenderTarget {
    const rt = new THREE.WebGLRenderTarget(w, h, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      generateMipmaps: false,
      depthBuffer: true,
      stencilBuffer: false,
      type: THREE.UnsignedByteType,
      colorSpace: THREE.SRGBColorSpace,
    });
    rt.depthTexture = new THREE.DepthTexture(w, h);
    rt.depthTexture.format = THREE.DepthFormat;
    rt.depthTexture.type = THREE.UnsignedShortType;
    return rt;
  }

  /** 屏幕尺寸变化时调用。 */
  setSize(screenW: number, screenH: number): { rtW: number; rtH: number } {
    const rtW = Math.max(2, Math.floor(screenW / this.options.pixelScale));
    const rtH = Math.max(2, Math.floor(screenH / this.options.pixelScale));
    this.rt.dispose();
    this.rt = this.makeRT(rtW, rtH);
    this.fsMaterial.uniforms.tDiffuse.value = this.rt.texture;
    return { rtW, rtH };
  }

  /** 取当前 RT 尺寸（HUD 用）。 */
  getRTSize(): { w: number; h: number } {
    return { w: this.rt.width, h: this.rt.height };
  }

  /** 主渲染调用：1) 场景→RT  2) RT→屏幕（nearest 放大）。 */
  render(scene: THREE.Scene, camera: THREE.Camera): void {
    // pass 1: 场景到低分辨率 RT
    this.renderer.setRenderTarget(this.rt);
    this.renderer.clear(true, true, false);
    this.renderer.render(scene, camera);

    // pass 2: RT 全屏放大到屏幕
    this.renderer.setRenderTarget(null);
    this.renderer.clear(true, false, false);
    this.renderer.render(this.fsScene, this.fsCamera);
  }

  /** 运行时切换量化开关（调试用）。 */
  setQuantize(on: boolean): void {
    this.options.quantize = on;
    this.fsMaterial.uniforms.uQuantize.value = on ? 1.0 : 0.0;
  }

  dispose(): void {
    this.rt.dispose();
    this.fsMaterial.dispose();
    (this.fsQuad.geometry as THREE.BufferGeometry).dispose();
  }
}
