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
import { buildScene, GRID_SIZE, GRID_W, GRID_D, getRoadRegions, getDistrictLayout } from './render/scene';
import { OrthoCityCamera } from './render/camera';
import { PixelPipeline } from './render/pixelPipeline';
import { AgentInstances } from './render/agents';
import { RoadTool, type Tool } from './render/roadTool';
import { SimHandle } from './sim/simHandle';
import { MAX_AGENTS } from './sim/types';
import type { DistrictSnapshot, ChainSnapshotItem, LineSnapshotItem } from './sim/types';
import { ROAD_WIDTH } from './sim/roadLayout';

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
// 9×3 街区的横向地图比 3×3 大一倍多，建筑数同步上调
// 迭代 3：起始建筑数下调到 600，留一半空间给"自动生长"演示
const TARGET_BUILDINGS = 600;
const { scene, pivot, buildingInstances, buildingCount, buildingSpecs, roadHeatmap } = buildScene(TARGET_BUILDINGS);

// --- 代理实例化网格 ---------------------------------------------------------
const agentInstances = new AgentInstances(MAX_AGENTS);
agentInstances.addToScene(scene);

// --- 迭代 3：街区调试可视化 -------------------------------------------------
// 用一组 PlaneGeometry 在街区底面铺一层半透明指示色（按 fulfillment 染色）
let latestDistricts: DistrictSnapshot[] | null = null;
let latestChain: ChainSnapshotItem[] | null = null;
let latestLines: LineSnapshotItem[] | null = null;
let latestProfitTick = 0;
let latestProfitAcc = 0;

// --- Sim Worker -------------------------------------------------------------
const PRESETS = [200, 500, 1000, 1500, 2000] as const;
let currentPreset = 2;     // 默认 1000 可见代理
let activeAgents = PRESETS[currentPreset];

const sim = new SimHandle({
  gridSize: GRID_SIZE,
  gridSizeX: GRID_W,
  gridSizeZ: GRID_D,
  seed: 42,
  buildings: buildingSpecs,
  roads: getRoadRegions(),
  districts: getDistrictLayout(),
  maxVisibleAgents: activeAgents,
  onSnapshot: (snap) => {
    agentInstances.ingestSnapshot(snap);
    if (snap.roads) roadHeatmap.apply(snap.roads);
    // 迭代 3：处理建筑增删差量
    if (snap.buildingDelta) {
      const { spawned, removed } = snap.buildingDelta;
      for (const uid of removed) {
        if (buildingInstances.removeByUid(uid)) growRemoveCount++;
      }
      for (const s of spawned) {
        const kind = s.kind === 0 ? 'residential' : s.kind === 1 ? 'commercial' : 'industrial';
        if (buildingInstances.add({
          kind,
          x: s.x, z: s.z, w: s.w, d: s.d, h: s.h,
          seed: s.seed,
          uid: s.uid,
        })) growSpawnCount++;
      }
    }
    if (snap.districts) latestDistricts = snap.districts;
    if (snap.chain) latestChain = snap.chain;
    if (snap.lines) latestLines = snap.lines;
    if (typeof snap.profitPerTick === 'number') latestProfitTick = snap.profitPerTick;
    if (typeof snap.profitAccumulated === 'number') latestProfitAcc = snap.profitAccumulated;
  },
  onRoadsChanged: (regions) => {
    // 迭代 3 R3：worker 通知路网变化（玩家增删路），主线程重建热力图条带
    roadHeatmap.rebuild(regions);
  },
});

// --- Camera ------------------------------------------------------------------
const cityCam = new OrthoCityCamera({
  pivot,
  viewSize: 36,           // 9×3 横向地图，初始视野适当拉大
  minViewSize: 8,
  maxViewSize: 72,
});
cityCam.attach(canvas);

// --- 道路工具（迭代 3 · M1 + Phase 4）-------------------------------------
// 容量密度与 scene.getRoadRegions 同口径，估算"玩家铺路"的通行容量
const ROAD_LANE_TOTAL = ROAD_WIDTH - 2 * 0.7;
const ROAD_CAPACITY_DENSITY = 0.6;
const roadTool = new RoadTool({
  scene,
  camera: cityCam.camera,
  canvas,
  gridW: GRID_W,
  gridD: GRID_D,
  roadWidth: ROAD_WIDTH,
  onPlace: (seg) => {
    // 计算 capacity（与 scene.ts 同口径）
    const length = seg.axis === 'NS' ? seg.d : seg.w;
    const capacity = ROAD_LANE_TOTAL * length * ROAD_CAPACITY_DENSITY;
    sim.addRoad(seg.id, {
      x: seg.x, z: seg.z, w: seg.w, d: seg.d, capacity,
    });
    return true;
  },
  onRemove: (id) => {
    sim.removeRoad(id);
    return true;
  },
});

function setActiveTool(t: Tool): void {
  roadTool.setTool(t);
  cityCam.setLeftButtonEnabled(t === 'select');
  // 工具栏按钮高亮
  for (const el of document.querySelectorAll<HTMLButtonElement>('.tool-btn')) {
    el.classList.toggle('active', el.dataset.tool === t);
  }
}

// 工具栏按钮 click
for (const btn of document.querySelectorAll<HTMLButtonElement>('.tool-btn')) {
  btn.addEventListener('click', () => {
    const t = btn.dataset.tool as Tool;
    setActiveTool(t);
  });
}

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
    &nbsp;<kbd>Space</kbd>/<kbd>P</kbd> 暂停 <span id="hud-p">1x</span>
    &nbsp;<kbd>[</kbd>/<kbd>]</kbd> 倍速
    &nbsp;<kbd>H</kbd> 热力图 <span id="hud-h">on</span>
    &nbsp;<kbd>B</kbd> 拓路（最堵）
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
    <dt>南北路（8 条）</dt><dd id="hud-r-ns">—</dd>
    <dt>东西路（2 条）</dt><dd id="hud-r-ew">—</dd>
    <dt>峰值拥堵</dt><dd id="hud-rpeak">—</dd>
    <dt>平均通勤</dt><dd id="hud-commute">—</dd>
  </dl>
</div>
<div style="margin-top:8px;padding-top:8px;border-top:1px solid #333a45;font-size:11px;line-height:1.6;">
  <div><b style="color:#7fd1ff">迭代 3 · 街区自生长</b></div>
  <dl style="display:grid;grid-template-columns:auto 1fr;gap:2px 12px;margin:0;color:#9aa3ad;">
    <dt>建筑总数</dt><dd id="hud-bcount">—</dd>
    <dt>住宅区平均</dt><dd id="hud-d-r">—</dd>
    <dt>商业区平均</dt><dd id="hud-d-c">—</dd>
    <dt>工业区平均</dt><dd id="hud-d-i">—</dd>
    <dt>近 1s 增/减</dt><dd id="hud-d-delta">—</dd>
  </dl>
</div>
<div style="margin-top:8px;padding-top:8px;border-top:1px solid #333a45;font-size:11px;line-height:1.6;">
  <div><b style="color:#7fd1ff">迭代 3 · 产业节点</b></div>
  <div id="hud-chain" style="display:grid;grid-template-columns:1fr;gap:3px;margin:4px 0 0 0;color:#9aa3ad;font-size:10.5px;">—</div>
</div>
<div style="margin-top:8px;padding-top:8px;border-top:1px solid #333a45;font-size:11px;line-height:1.6;">
  <div><b style="color:#7fd1ff">迭代 3 · 运输线</b>
    &nbsp;本 tick <span id="hud-profit-tick">—</span>
    &nbsp;累计 <span id="hud-profit-acc">—</span>
  </div>
  <div id="hud-lines" style="display:grid;grid-template-columns:1fr;gap:3px;margin:4px 0 0 0;color:#9aa3ad;font-size:10.5px;">—</div>
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
const hudRoadNS = document.getElementById('hud-r-ns') as HTMLElement;
const hudRoadEW = document.getElementById('hud-r-ew') as HTMLElement;
const hudRPeak = document.getElementById('hud-rpeak') as HTMLElement;
const hudCommute = document.getElementById('hud-commute') as HTMLElement;

// 迭代 3 · 街区自生长 HUD
const hudBCount = document.getElementById('hud-bcount') as HTMLElement;
const hudDR = document.getElementById('hud-d-r') as HTMLElement;
const hudDC = document.getElementById('hud-d-c') as HTMLElement;
const hudDI = document.getElementById('hud-d-i') as HTMLElement;
const hudDDelta = document.getElementById('hud-d-delta') as HTMLElement;

// 迭代 3 · 产业节点 HUD
const hudChain = document.getElementById('hud-chain') as HTMLElement;
// 迭代 3 · 运输线 HUD
const hudLines = document.getElementById('hud-lines') as HTMLElement;
const hudProfitTick = document.getElementById('hud-profit-tick') as HTMLElement;
const hudProfitAcc = document.getElementById('hud-profit-acc') as HTMLElement;

// 用于统计 1 秒内 spawn / shrink 数
let growSpawnCount = 0;
let growRemoveCount = 0;
let growStatAt = performance.now();
let growSpawnDisplay = 0;
let growRemoveDisplay = 0;

hudBuildings.textContent = String(buildingCount);

function updatePresetHUD(): void {
  hudPreset.textContent = `${activeAgents} (F${currentPreset + 1})`;
}
updatePresetHUD();

// --- 键盘快捷键 -------------------------------------------------------------
let simPaused = false;
let heatmapOn = true;
const SPEEDS = [1, 2, 4] as const;
let speedIdx = 0;       // 0→1x, 1→2x, 2→4x
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
  } else if (e.key === ' ' || e.key.toLowerCase() === 'p') {
    e.preventDefault();
    simPaused = !simPaused;
    if (simPaused) sim.pause(); else sim.resume();
    hudP.textContent = simPaused ? 'paused' : `${SPEEDS[speedIdx]}x`;
    hudP.style.color = simPaused ? '#ffb84d' : '#6dd58c';
  } else if (e.key === '[') {
    if (speedIdx > 0) speedIdx--;
    sim.setSpeed(SPEEDS[speedIdx]);
    if (!simPaused) hudP.textContent = `${SPEEDS[speedIdx]}x`;
  } else if (e.key === ']') {
    if (speedIdx < SPEEDS.length - 1) speedIdx++;
    sim.setSpeed(SPEEDS[speedIdx]);
    if (!simPaused) hudP.textContent = `${SPEEDS[speedIdx]}x`;
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
  } else if (e.key.toLowerCase() === 'b') {
    // E3：演示"玩家拓路"——把当前最堵的父路 capacity 翻倍
    const snap = sim.getSnapshot();
    if (snap?.roads) {
      let bestId = 0;
      let bestCong = -1;
      const r = snap.roads;
      const total = r.length / 2;
      for (let i = 0; i < total; i++) {
        const cong = r[i * 2 + 1];
        if (cong > bestCong) { bestCong = cong; bestId = i; }
      }
      sim.boostRoad(bestId, 2);
      console.log(`[E3] boosted road #${bestId} (cong=${(bestCong * 100).toFixed(0)}%) ×2`);
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

    // C3 道路压力（NS 8 + EW 2，按组聚合显示）
    const r = snap.roads;
    if (r) {
      const totalRoads = r.length / 2;
      // NS 路是前 8 条，EW 是后面 2 条（与 getRoadRegions 顺序一致）
      const NS_COUNT = Math.min(8, totalRoads);
      let nsFlow = 0, nsPeak = 0;
      let ewFlow = 0, ewPeak = 0;
      let peak = 0;
      for (let i = 0; i < totalRoads; i++) {
        const flow = r[i * 2] | 0;
        const cong = r[i * 2 + 1];
        if (i < NS_COUNT) {
          nsFlow += flow;
          if (cong > nsPeak) nsPeak = cong;
        } else {
          ewFlow += flow;
          if (cong > ewPeak) ewPeak = cong;
        }
        if (cong > peak) peak = cong;
      }
      const fmt = (flow: number, c: number, el: HTMLElement) => {
        const pct = (c * 100).toFixed(0);
        el.textContent = `${flow} 人 · 峰值 ${pct}%`;
        el.style.color = c > 0.7 ? '#ff5d4f' : c > 0.4 ? '#fdd06a' : '#7ed085';
      };
      fmt(nsFlow, nsPeak, hudRoadNS);
      fmt(ewFlow, ewPeak, hudRoadEW);
      const peakPct = (peak * 100).toFixed(0);
      hudRPeak.textContent = `${peakPct}%`;
      hudRPeak.style.color = peak > 0.7 ? '#ff5d4f' : peak > 0.4 ? '#fdd06a' : '#7ed085';
    }

    // E3: 平均通勤（从 city 字段拿）
    if (c) {
      const tgt = c.targetCommuteSec;
      const avg = c.avgCommuteSec;
      if (avg > 0) {
        hudCommute.textContent = `${avg.toFixed(1)}s / 目标 ${tgt.toFixed(0)}s`;
        const ratio = avg / Math.max(0.01, tgt);
        hudCommute.style.color = ratio > 1.4 ? '#ff5d4f' : ratio > 1.0 ? '#fdd06a' : '#7ed085';
      } else {
        hudCommute.textContent = `— / 目标 ${tgt.toFixed(0)}s`;
        hudCommute.style.color = '#9aa3ad';
      }
    }

    // 迭代 3：街区状态
    if (latestDistricts && latestDistricts.length > 0) {
      let rSum = 0, rCount = 0, rBuildings = 0;
      let cSum = 0, cCount = 0, cBuildings = 0;
      let iSum = 0, iCount = 0, iBuildings = 0;
      for (const d of latestDistricts) {
        if (d.zone === 0) { rSum += d.fulfillment; rCount++; rBuildings += d.buildings; }
        else if (d.zone === 1) { cSum += d.fulfillment; cCount++; cBuildings += d.buildings; }
        else { iSum += d.fulfillment; iCount++; iBuildings += d.buildings; }
      }
      hudBCount.textContent = `${rBuildings + cBuildings + iBuildings}（R ${rBuildings} · C ${cBuildings} · I ${iBuildings}）`;
      const fmtFul = (sum: number, n: number, count: number, el: HTMLElement) => {
        const avg = n > 0 ? sum / n : 0;
        el.textContent = `${avg.toFixed(2)} （${count} 街区）`;
        el.style.color = avg >= 0.85 ? '#7ed085' : avg <= 0.35 ? '#ff5d4f' : '#fdd06a';
      };
      fmtFul(rSum, rCount, rCount, hudDR);
      fmtFul(cSum, cCount, cCount, hudDC);
      fmtFul(iSum, iCount, iCount, hudDI);
    }
    // 1s 频率刷新增减
    if (now - growStatAt >= 1000) {
      growSpawnDisplay = growSpawnCount;
      growRemoveDisplay = growRemoveCount;
      growSpawnCount = 0;
      growRemoveCount = 0;
      growStatAt = now;
    }
    if (hudFrame % 6 === 0) {
      hudDDelta.textContent = `+${growSpawnDisplay} / -${growRemoveDisplay}`;
      hudDDelta.style.color =
        growSpawnDisplay > growRemoveDisplay ? '#7ed085' :
        growRemoveDisplay > growSpawnDisplay ? '#ff5d4f' : '#9aa3ad';
    }

    // 迭代 3 · 产业节点 HUD
    if (latestChain && hudFrame % 6 === 0) {
      const lines: string[] = [];
      for (const n of latestChain) {
        const inStr = n.inBuf.length === 0 ? '—'
          : n.inBuf.map((b) => `${b.res}:${Math.round(b.qty)}`).join(' ');
        const outStr = n.outBuf.length === 0 ? '—'
          : n.outBuf.map((b) => `${b.res}:${Math.round(b.qty)}`).join(' ');
        const lvlColor = n.level >= 3 ? '#7ed085' : n.level === 2 ? '#fdd06a' : '#9aa3ad';
        lines.push(
          `<div>` +
          `<span style="color:#7fd1ff">${n.producerId}</span> ` +
          `<span style="color:${lvlColor}">L${n.level}</span>` +
          ` <span style="color:#666;font-size:10px">in</span> ${inStr}` +
          ` <span style="color:#666;font-size:10px">out</span> ${outStr}` +
          `</div>`,
        );
      }
      hudChain.innerHTML = lines.join('') || '—';
    }

    // 迭代 3 · 运输线 HUD
    if (hudFrame % 6 === 0) {
      const pt = latestProfitTick;
      const pa = latestProfitAcc;
      hudProfitTick.textContent = pt.toFixed(2);
      hudProfitTick.style.color = pt > 0 ? '#7ed085' : pt < 0 ? '#ff9a55' : '#9aa3ad';
      hudProfitAcc.textContent = pa.toFixed(0);
      hudProfitAcc.style.color = pa > 0 ? '#7ed085' : pa < 0 ? '#ff5d4f' : '#9aa3ad';
      if (latestLines && latestLines.length > 0) {
        const rows: string[] = [];
        for (const l of latestLines) {
          const profitColor = l.revenue > 0 ? '#7ed085' : l.revenue < 0 ? '#ff9a55' : '#9aa3ad';
          rows.push(
            `<div>` +
            `<span style="color:#7fd1ff">#${l.id}</span> ` +
            `${l.resource} · ` +
            `<span style="color:#aaa">${l.vehicleId}×${l.fleet}</span> · ` +
            `送达 ${Math.round(l.delivered)} · ` +
            `<span style="color:${profitColor}">利 ${l.revenue.toFixed(1)}</span>` +
            `</div>`,
          );
        }
        hudLines.innerHTML = rows.join('');
      } else {
        hudLines.innerHTML = '—';
      }
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
