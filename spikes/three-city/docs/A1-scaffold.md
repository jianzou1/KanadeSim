# Task A1 · 工程脚手架验收

> 阶段：A · 工程脚手架与画面探针
> 状态：✅ 完成
> 日期：2026-05-26

## 完成内容

- **工程结构**：`spikes/three-city/`，遵循 design.md §4 模拟/渲染分离原则
  ```
  src/
  ├── main.ts          # 启动器（A1 阶段：Hello Cube + HUD）
  ├── render/          # 预留，A2 起填入
  ├── sim/             # 预留，B1 起填入
  ├── input/           # 预留
  └── ui/              # 预留
  ```
- **构建链**：Vite 7.3.3 + TypeScript 5.9 + ESM
- **运行时依赖**：
  - `three@0.182.0`
  - `comlink@4.4.2`（Worker 通信，B1 用）
  - `zustand@5.0.8`（debug 面板状态，C 阶段用）
- **HUD**：原生 HTML/CSS，显示 FPS / Renderer / Resolution
- **正交相机**：已配 `OrthographicCamera`（viewSize=6, 8/8/8 视角），为 A2 像素探针打底

## 验证结果

| 检查项 | 结果 |
|---|---|
| `npx tsc --noEmit` | ✅ 零错误 |
| `npx vite build` | ✅ 6 modules / 493KB / 456ms |
| `npx vite` dev server | ✅ 70ms 启动，端口 5180 |
| 浏览器实际渲染 | ✅ Hello Cube 旋转、HUD 显示正常 |

## 关键决策记录

- **包管理器**：npm（用户选定，理由：Node 自带，零额外安装成本）
- **three.js 版本**：r182（用户选定最新稳定版）
- **canvas 像素化策略**：CSS `image-rendering: pixelated` + WebGL `antialias: false`，为 A2 nearest filter 打底
- **HUD 实现**：原生 HTML，不上 React（spike 阶段保持轻量）
- **Worker 格式**：Vite 配置 `worker.format: 'es'`，方便 B1 用 ESM Worker

## 下一步

→ **Task A2 · 画面探针**：换掉 Hello Cube，正经做"正交像素 + 低模建筑 + nearest 放大"，主观评审画面够不够看。
