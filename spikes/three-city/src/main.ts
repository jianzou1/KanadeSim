/**
 * KanadeSim · three-city spike · Task A2 主入口
 *
 * 拼装顺序：
 *   1. 渲染器（关闭 AA，保证像素边缘干净）
 *   2. 场景（程序化生成的微型街区）
 *   3. 正交相机（东南俯视，支持旋转/缩放）
 *   4. 像素管线（低分辨率 RT + nearest 放大）
 *   5. HUD + 键盘快捷键
 *
 * 评审重点：画面"够不够看"——参考 design.md §3 的 2.5D 路线
 */

import * as THREE from 'three';
import { buildScene, GRID_SIZE, getRoadRegions } from './render/scene';
import { OrthoCityCamera } from './render/camera';
import { PixelPipeline } from './render/pixelPipeline';
import { AgentInstances } from './render/agents';
import { SimHandle } from './sim/simHandle';
import { MAX_AGENTS } from './sim/types';

// --- DOM ---------------------------------------------------------------------
const canvas = document.getElementById('scene') as HTMLCanvasElement;
const hudStatus = document.getElementById('hud-status') as HTMLElement;
const hudFps = document.getElementById('hud-fps') as HTMLElement;
const hudRenderer = document.getElementById('hud-renderer') as HTMLElement;
const hudResolution = document.getElementById('hud-resolution') as HTMLElement;
const clockText = document.getElementById('clock-text') as HTMLElement;
const clockPhase = document.getElementById('clock-phase') as HTMLElement;

// 阻止右键菜单（相机要用右键拖拽）
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

// --- Renderer ----------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: false,           // 像素风必须关
  powerPreference: 'high-performance',
  alpha: false,
});
renderer.setPixelRatio(1);    // 像素管线自己控制分辨率，devicePixelRatio 留给 CSS
renderer.outputColorSpace = THREE.SRGBColorSpace;
// 轻度色调映射 + 适度曝光，避免色彩"压暗"
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;

// --- Scene -------------------------------------------------------------------
const TARGET_BUILDINGS = 500;
const { scene, pivot, buildingCount, buildingSpecs, roadHeatmap } = buildScene(TARGET_BUILDINGS);

// --- 代理实例化网格 ---------------------------------------------------------
const agentInstances = new AgentInstances(MAX_AGENTS);
agentInstances.addToScene(scene);

// --- Sim Worker -------------------------------------------------------------
const PRESETS = [200, 500, 1000, 1500, 2000] as const;
let currentPreset = 2;     // 默认 1000 可见代理
let activeAgents = PRESETS[currentPreset];

const sim = new SimHandle({
  gridSize: GRID_SIZE,
  seed: 42,
  buildings: buildingSpecs,
  roads: getRoadRegions(),
  maxVisibleAgents: activeAgents,
  onSnapshot: (snap) => {
    agentInstances.ingestSnapshot(snap);
    if (snap.roads) roadHeatmap.apply(snap.roads);
  },
});

// --- Camera ------------------------------------------------------------------
const cityCam = new OrthoCityCamera({
  pivot,
  viewSize: 18,
  minViewSize: 6,
  maxViewSize: 32,
});
cityCam.attach(canvas);

// --- Pixel Pipeline（可热替换）-----------------------------------------------
let pixelScale = 3;
let quantize = false;
let pipeline = new PixelPipeline(renderer, { pixelScale, quantize });

function rebuildPipeline(): void {
  pipeline.dispose();
  pipeline = new PixelPipeline(renderer, { pixelScale, quantize });
  applySize();
}

function applySize(): void {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h, false);
  cityCam.resize(w, h);
  const { rtW, rtH } = pipeline.setSize(w, h);
  hudResolution.textContent = `${rtW}×${rtH} → ${w}×${h} (×${pixelScale})`;
}

window.addEventListener('resize', applySize);

// --- HUD 扩展 ---------------------------------------------------------------
const hud = document.getElementById('hud')!;
const extra = document.createElement('div');
extra.style.cssText = 'margin-top:8px;padding-top:8px;border-top:1px solid #333a45;font-size:11px;color:#9aa3ad;line-height:1.6;';
extra.innerHTML = `
  <div><b style="color:#7fd1ff">A2/B2 · 镜头与画质</b></div>
  <div>左/右键拖拽：旋转 &nbsp; 滚轮：缩放 &nbsp; 方向键：微调</div>
  <div style="margin-top:6px">
    <kbd>1</kbd>/<kbd>2</kbd>/<kbd>3</kbd>/<kbd>4</kbd> 像素比例
    &nbsp;<kbd>Q</kbd> 减色 <span id="hud-q">off</span>
    &nbsp;<kbd>P</kbd> 暂停 <span id="hud-p">running</span>
    &nbsp;<kbd>H</kbd> 热力图 <span id="hud-h">on</span>
  </div>
  <div style="margin-top:4px">视角 az=<span id="hud-az">—</span>° el=<span id="hud-el">—</span>°</div>
</div>
<div style="margin-top:8px;padding-top:8px;border-top:1px solid #333a45;font-size:11px;line-height:1.6;">
  <div><b style="color:#7fd1ff">C2 · 城市经济</b></div>
  <dl style="display:grid;grid-template-columns:auto 1fr;gap:2px 12px;margin:0;color:#9aa3ad;">
    <dt>人口</dt><dd id="hud-pop">—</dd>
    <dt>住房容量</dt><dd id="hud-housing">—</dd>
    <dt>岗位</dt><dd id="hud-jobs">—</dd>
    <dt>在职</dt><dd id="hud-employed">—</dd>
    <dt>失业率</dt><dd id="hud-unemp">—</dd>
    <dt>商业覆盖</dt><dd id="hud-comm">—</dd>
    <dt>平均满意度</dt><dd id="hud-sat">—</dd>
    <dt>驾车率</dt><dd id="hud-driver">—</dd>
    <dt>本 tick 税收</dt><dd id="hud-taxtick">—</dd>
    <dt>累计税收</dt><dd id="hud-tax">—</dd>
  </dl>
</div>
<div style="margin-top:8px;padding-top:8px;border-top:1px solid #333a45;font-size:11px;line-height:1.6;">
  <div><b style="color:#7fd1ff">C3 · 道路压力</b></div>
  <dl style="display:grid;grid-template-columns:auto 1fr;gap:2px 12px;margin:0;color:#9aa3ad;">
    <dt>NS-1 (x=10)</dt><dd id="hud-r0">—</dd>
    <dt>NS-2 (x=22)</dt><dd id="hud-r1">—</dd>
    <dt>EW-1 (z=10)</dt><dd id="hud-r2">—</dd>
    <dt>EW-2 (z=22)</dt><dd id="hud-r3">—</dd>
    <dt>峰值拥堵</dt><dd id="hud-rpeak">—</dd>
  </dl>
</div>
<div style="margin-top:8px;padding-top:8px;border-top:1px solid #333a45;font-size:11px;line-height:1.6;">
  <div><b style="color:#7fd1ff">B2 · 性能压测</b></div>
  <div style="margin-bottom:4px">
    可见代理：<kbd>F1</kbd>=200 <kbd>F2</kbd>=500 <kbd>F3</kbd>=1000 <kbd>F4</kbd>=1500 <kbd>F5</kbd>=2000
  </div>
  <dl style="display:grid;grid-template-columns:auto 1fr;gap:2px 12px;margin:0;color:#9aa3ad;">
    <dt>代理档位</dt><dd id="hud-preset" style="color:#7fd1ff">—</dd>
    <dt>建筑数</dt><dd id="hud-buildings">—</dd>
    <dt>可见代理</dt><dd id="hud-agents">—</dd>
    <dt>Tick</dt><dd id="hud-tick">—</dd>
    <dt>Tick 频率</dt><dd id="hud-rate">—</dd>
    <dt>Tick 耗时</dt><dd id="hud-tickms">—</dd>
    <dt>消息间隔</dt><dd id="hud-msginterval">—</dd>
    <dt>带宽</dt><dd id="hud-bw">—</dd>
    <dt>Draw calls</dt><dd id="hud-draws">—</dd>
    <dt>三角形</dt><dd id="hud-tris">—</dd>
    <dt>JS Heap</dt><dd id="hud-heap">—</dd>
  </dl>
`;
hud.appendChild(extra);
const hudAz = document.getElementById('hud-az') as HTMLElement;
const hudEl = document.getElementById('hud-el') as HTMLElement;
const hudQ = document.getElementById('hud-q') as HTMLElement;
const hudP = document.getElementById('hud-p') as HTMLElement;
const hudPreset = document.getElementById('hud-preset') as HTMLElement;
const hudBuildings = document.getElementById('hud-buildings') as HTMLElement;
const hudAgents = document.getElementById('hud-agents') as HTMLElement;
const hudTick = document.getElementById('hud-tick') as HTMLElement;
const hudRate = document.getElementById('hud-rate') as HTMLElement;
const hudTickMs = document.getElementById('hud-tickms') as HTMLElement;
const hudMsgInterval = document.getElementById('hud-msginterval') as HTMLElement;
const hudBw = document.getElementById('hud-bw') as HTMLElement;
const hudDraws = document.getElementById('hud-draws') as HTMLElement;
const hudTris = document.getElementById('hud-tris') as HTMLElement;
const hudHeap = document.getElementById('hud-heap') as HTMLElement;

// C2 城市经济 HUD
const hudPop = document.getElementById('hud-pop') as HTMLElement;
const hudHousing = document.getElementById('hud-housing') as HTMLElement;
const hudJobs = document.getElementById('hud-jobs') as HTMLElement;
const hudEmployed = document.getElementById('hud-employed') as HTMLElement;
const hudUnemp = document.getElementById('hud-unemp') as HTMLElement;
const hudComm = document.getElementById('hud-comm') as HTMLElement;
const hudSat = document.getElementById('hud-sat') as HTMLElement;
const hudDriver = document.getElementById('hud-driver') as HTMLElement;
const hudTaxTick = document.getElementById('hud-taxtick') as HTMLElement;
const hudTax = document.getElementById('hud-tax') as HTMLElement;

// C3 道路压力 HUD
const hudH = document.getElementById('hud-h') as HTMLElement;
const hudRoads = [
  document.getElementById('hud-r0') as HTMLElement,
  document.getElementById('hud-r1') as HTMLElement,
  document.getElementById('hud-r2') as HTMLElement,
  document.getElementById('hud-r3') as HTMLElement,
];
const hudRPeak = document.getElementById('hud-rpeak') as HTMLElement;

hudBuildings.textContent = String(buildingCount);

function updatePresetHUD(): void {
  hudPreset.textContent = `${activeAgents} (F${currentPreset + 1})`;
}
updatePresetHUD();

// --- 键盘快捷键 -------------------------------------------------------------
let simPaused = false;
let heatmapOn = true;
window.addEventListener('keydown', (e) => {
  if (e.key >= '1' && e.key <= '4') {
    const next = parseInt(e.key, 10);
    if (next !== pixelScale) {
      pixelScale = next;
      rebuildPipeline();
    }
  } else if (e.key.toLowerCase() === 'q') {
    quantize = !quantize;
    pipeline.setQuantize(quantize);
    hudQ.textContent = quantize ? 'on' : 'off';
    hudQ.style.color = quantize ? '#7fd1ff' : '#9aa3ad';
  } else if (e.key.toLowerCase() === 'p') {
    simPaused = !simPaused;
    if (simPaused) sim.pause(); else sim.resume();
    hudP.textContent = simPaused ? 'paused' : 'running';
    hudP.style.color = simPaused ? '#ffb84d' : '#6dd58c';
  } else if (e.key.toLowerCase() === 'h') {
    heatmapOn = !heatmapOn;
    roadHeatmap.setVisible(heatmapOn);
    hudH.textContent = heatmapOn ? 'on' : 'off';
    hudH.style.color = heatmapOn ? '#7fd1ff' : '#9aa3ad';
  } else if (e.key === 'F1' || e.key === 'F2' || e.key === 'F3' || e.key === 'F4' || e.key === 'F5') {
    e.preventDefault();
    const idx = parseInt(e.key.slice(1), 10) - 1;
    if (idx >= 0 && idx < PRESETS.length) {
      currentPreset = idx;
      activeAgents = PRESETS[idx];
      sim.reset({ maxVisibleAgents: activeAgents });
      updatePresetHUD();
    }
  }
});

// --- FPS HUD -----------------------------------------------------------------
let frames = 0;
let lastFpsAt = performance.now();
function updateFps(now: number) {
  frames++;
  const elapsed = now - lastFpsAt;
  if (elapsed >= 500) {
    const fps = (frames * 1000) / elapsed;
    hudFps.textContent = `${fps.toFixed(1)} fps`;
    hudFps.className = fps >= 55 ? 'ok' : fps >= 30 ? '' : 'warn';
    frames = 0;
    lastFpsAt = now;
  }
}

// --- Main Loop ---------------------------------------------------------------
let hudFrame = 0;
function tick(now: number) {
  // 60Hz 插值：把 Worker 4Hz 的快照平滑成连续动画
  agentInstances.renderTick(now);

  pipeline.render(scene, cityCam.camera);
  updateFps(now);
  hudAz.textContent = cityCam.getAzimuthDeg().toFixed(0);
  hudEl.textContent = cityCam.getElevationDeg().toFixed(0);

  // Sim HUD（每帧更新代价低）
  const snap = sim.getSnapshot();
  const stats = sim.getStats();
  if (snap && stats) {
    hudAgents.textContent = `${snap.activeAgents} / ${MAX_AGENTS}`;
    hudTick.textContent = String(snap.tick);
    hudRate.textContent = `${stats.ticksPerSec.toFixed(2)} Hz`;
    hudTickMs.textContent = `${stats.lastTickMs.toFixed(2)} ms (avg ${stats.avgTickMs.toFixed(2)})`;
    hudMsgInterval.textContent = `${sim.getMessageIntervalMs().toFixed(1)} ms`;
    const kbps = sim.getBytesPerSec() / 1024;
    hudBw.textContent = `${kbps.toFixed(1)} KB/s · ${(stats.snapshotBytes / 1024).toFixed(1)} KB/snap`;

    // 城市经济
    const c = snap.city;
    if (c) {
      hudPop.textContent = c.population.toLocaleString();
      hudHousing.textContent = `${c.population.toLocaleString()} / ${c.housingCapacity.toLocaleString()} (${(c.housingDemandPressure * 100).toFixed(0)}%)`;
      hudJobs.textContent = c.jobs.toLocaleString();
      hudEmployed.textContent = `${c.employed.toLocaleString()} / ${c.jobs.toLocaleString()}`;
      const unempPct = c.unemploymentRate * 100;
      hudUnemp.textContent = `${unempPct.toFixed(1)}%`;
      hudUnemp.style.color = unempPct > 15 ? '#ff9a55' : unempPct > 5 ? '#fdd06a' : '#6dd58c';
      const commPct = c.commercialCoverage * 100;
      hudComm.textContent = `${commPct.toFixed(0)}%`;
      hudComm.style.color = commPct < 50 ? '#ff9a55' : commPct < 80 ? '#fdd06a' : '#6dd58c';
      const satPct = c.satisfactionAvg * 100;
      hudSat.textContent = `${satPct.toFixed(0)}%`;
      hudSat.style.color = satPct < 40 ? '#ff9a55' : satPct < 65 ? '#fdd06a' : '#6dd58c';
      hudDriver.textContent = `${(c.driverRate * 100).toFixed(0)}%`;
      hudTaxTick.textContent = c.taxPerTick.toFixed(2);
      hudTax.textContent = c.taxAccumulated.toFixed(0);

      // 时钟
      const totalMin = Math.floor(c.hour * 60);
      const hh = Math.floor(totalMin / 60);
      const mm = totalMin % 60;
      clockText.textContent = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
      const phase = hh < 6 ? '深夜' : hh < 9 ? '早高峰' : hh < 17 ? '白天' : hh < 20 ? '晚高峰' : '夜晚';
      clockPhase.textContent = phase;
      const phaseColor = phase === '早高峰' || phase === '晚高峰' ? '#ff9a55' :
                         phase === '白天' ? '#7ed085' : '#7fb3ff';
      clockText.style.color = phaseColor;
    }

    // C3 道路压力
    const r = snap.roads;
    if (r) {
      let peak = 0;
      for (let i = 0; i < 4 && i < r.length / 2; i++) {
        const flow = r[i * 2] | 0;
        const cong = r[i * 2 + 1];
        const pct = (cong * 100).toFixed(0);
        const el = hudRoads[i];
        if (el) {
          el.textContent = `${flow} 人 · ${pct}%`;
          el.style.color = cong > 0.7 ? '#ff5d4f' : cong > 0.4 ? '#fdd06a' : '#7ed085';
        }
        if (cong > peak) peak = cong;
      }
      const peakPct = (peak * 100).toFixed(0);
      hudRPeak.textContent = `${peakPct}%`;
      hudRPeak.style.color = peak > 0.7 ? '#ff5d4f' : peak > 0.4 ? '#fdd06a' : '#7ed085';
    }
  }

  // 渲染指标每 6 帧更新一次（避免每帧 dom 操作干扰 FPS 测量）
  hudFrame++;
  if (hudFrame % 6 === 0) {
    const info = renderer.info;
    // info.render.calls 在一次 render 后是这次的；像素管线共 2 个 pass，所以建筑场景 = calls - 1
    hudDraws.textContent = `${info.render.calls}`;
    hudTris.textContent = `${(info.render.triangles / 1000).toFixed(1)}k`;
    const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    if (mem) {
      hudHeap.textContent = `${(mem.usedJSHeapSize / 1048576).toFixed(1)} MB`;
    } else {
      hudHeap.textContent = '— (非 Chromium)';
    }
  }

  requestAnimationFrame(tick);
}

// --- Bootstrap ---------------------------------------------------------------
applySize();
hudStatus.textContent = 'A2 探针运行中';
hudStatus.className = 'ok';
hudRenderer.textContent = `WebGL · three r${THREE.REVISION}`;
requestAnimationFrame(tick);

if (import.meta.hot) {
  import.meta.hot.accept(() => location.reload());
}
