# three-city spike

KanadeSim 引擎选型调研 spike。**单线押注 three.js**，目标产出可玩 demo + 桌面端打包验证。

> 完整调研计划：`/Users/sheltonchu/.workbuddy/plans/quantum-pulse-lovelace.md`
> 原始需求：`KanadeSim/design.md`

---

## 快速开始

```bash
cd spikes/three-city
npm install
npm run dev      # 默认 http://localhost:5180
```

---

## 目录约定（遵循 design.md §4 模拟/渲染分离）

```
src/
├── main.ts          # 启动器
├── render/          # three.js 渲染层（主线程）
├── sim/             # 模拟层（Web Worker，B1 起开始填）
├── input/           # 鼠标/键盘
└── ui/              # 原生 HTML HUD（不上 React）
electron/            # D1 桌面端打包
docs/                # 各任务的产出报告
```

---

## 任务进度

| 任务 | 状态 | 产出 |
|---|---|---|
| A1 · 工程脚手架 | ✅ 完成 | 本目录、HMR 跑通 |
| A2 · 画面探针 | ✅ 通过 | `docs/A2-visual-probe.md` |
| B1 · Worker 骨架 | ✅ 完成 | `src/sim/` + `docs/B1-worker-scaffold.md` |
| B2 · 1000 代理压测 | 🟡 待跑数据 | `docs/B2-perf-report.md` |
| C1 · 地图编辑 | ⏸️ 推迟到迭代 2 | — |
| C2 · 人口模拟 | ✅ 完成 | `docs/C2-population.md` |
| C3 · 通勤流可视化 | ✅ 完成 | `docs/C3-traffic-heatmap.md` |
| D1 · Electron 打包 | ⚪ 待开始 | `docs/D1-packaging.md` |
| D2 · 决策报告 | ⚪ 待开始 | `KanadeSim/docs/decision.md` |
