# Task B2 · 性能压测报告

> 阶段：B · 模拟核心与性能压测
> 状态：🟡 待用户跑数据并评审
> 日期：2026-05-26
> 关联 Q：**Q2 · 60fps · Q3 · Worker 通信开销**

---

## 1. 压测方法

### 1.1 场景规模
- 地图：**32×32 tile**（B1 的 4 倍面积）
- 道路：井字路，2 条南北 + 2 条东西，分出 9 个街区
- 建筑：**500 栋**（住宅 / 商业 / 工业），全部走 **InstancedMesh**
- 渲染管线：低分辨率 RT (pixelScale=3) + nearest 放大

### 1.2 代理档位（运行时切换）
| 快捷键 | 代理数 | 设计场景 |
|---|---|---|
| <kbd>F1</kbd> | 200 | B1 基线复测 |
| <kbd>F2</kbd> | 500 | 中等城市 |
| <kbd>F3</kbd> | **1000** | **MVP 目标值**（design.md §11）|
| <kbd>F4</kbd> | 1500 | 余量测试 |
| <kbd>F5</kbd> | 2000 | 上限测试（接近 MAX_AGENTS） |

### 1.3 关键指标
- **FPS**：HUD 实时显示，目标 ≥ 55 fps（中端 MBP）/ ≥ 30 fps（主流 Win）
- **Tick 耗时**：Worker 单 tick 处理 N 代理的毫秒数，目标 < 5ms（远小于 250ms tick 间隔）
- **消息间隔**：Main 收快照的实际间隔，目标 ~250ms（Worker 没卡住的话）
- **带宽**：N × 16 bytes × 4Hz，理论值 = activeAgents × 64 byte/s
- **Draw calls**：理论 = 2 + 4 + 1 = 7（像素管线 + 建筑 4 + 代理 1）
- **三角形**：建筑 ~500 × 12 + 代理 ~N × 12 = (500+N)*12

---

## 2. 实测数据

### 2.1 平台 A · macOS / 中端机
> 待用户填写。建议浏览器：Chrome 最新版

| 档位 | FPS | Tick 耗时 | 消息间隔 | 带宽 | Draw calls | 三角形 | JS Heap |
|---|---|---|---|---|---|---|---|
| F1 (200) | | | | | | | |
| F2 (500) | | | | | | | |
| F3 (1000) | | | | | | | |
| F4 (1500) | | | | | | | |
| F5 (2000) | | | | | | | |

### 2.2 平台 B · Windows 主流笔记本
> 待用户填写

| 档位 | FPS | Tick 耗时 | 消息间隔 | 带宽 | Draw calls | 三角形 | JS Heap |
|---|---|---|---|---|---|---|---|
| F1 (200) | | | | | | | |
| F2 (500) | | | | | | | |
| F3 (1000) | | | | | | | |
| F4 (1500) | | | | | | | |
| F5 (2000) | | | | | | | |

---

## 3. 评审

### 3.1 卡点判定（Q2/Q3）

> 这里是 B 阶段的硬卡点。

**Q2 · FPS 通过线**
- [ ] ✅ 通过 — F3 (1000 代理) 在两个平台均 ≥ 30fps，MBP ≥ 55fps
- [ ] ⚠️ 部分通过 — Mac 通过、Win 不达标 → 需要做一轮优化再复测
- [ ] ❌ 否决 — F3 也跑不到 30fps，需要架构性调整

**Q3 · Worker 通信通过线**
- [ ] ✅ 通过 — F3 下 Tick 耗时 < 5ms、消息间隔稳定在 250±20ms
- [ ] ⚠️ 部分通过 — 平均通过，偶有抖动 → 加 SharedArrayBuffer 或 perf 优化
- [ ] ❌ 否决 — Worker 卡住、消息间隔超 500ms

### 3.2 决策

根据测得数据，下一阶段应该是：
- [ ] 继续 C 阶段（性能富余，可上经营闭环）
- [ ] 先做一轮优化（具体动作见下）
- [ ] 调整 MVP 目标规模（如目标降到 500 代理）

---

## 4. 优化备选（如果 F3 不达标）

按"投入产出比"排序，建议从上往下试：

| 优化 | 投入 | 预期提升 |
|---|---|---|
| 降 pixelScale 到 4（渲染负载减半）| 5 分钟 | 渲染端 +30% FPS |
| AgentInstances 用 Float32Array 直填 instanceMatrix | 1 小时 | 主线程渲染端 +20% |
| 把 Tick 频率从 4Hz 降到 2Hz（插值仍 60Hz） | 10 分钟 | Worker CPU -50% |
| 建筑 LOD：屏幕外不更新 instanceMatrix | 2 小时 | 主线程 GC -X |
| Math.hypot → 自写 sqrt | 30 分钟 | Worker 5-10% |
| 上 SharedArrayBuffer（需 COOP/COEP headers）| 半天 | 通信开销 -90% |

---

## 5. 已知与本测无关的因素（避免误判）

- **Dev server vs Production**：Vite dev 的 HMR 会增加主线程开销，**真要看准数据请用 `npm run build && npm run preview`**
- **DevTools 打开**：Chrome DevTools 会让 FPS 掉一半左右，关掉 DevTools 跑准数
- **`performance.memory` 仅 Chromium**：Firefox / Safari 上 JS Heap 一栏会显示 "—"
- **窗口大小**：窗口越大，pixel pipeline RT 越大，渲染端开销越高
- **滚轮缩放后 viewSize 变化**：不影响 draw call 但影响裁剪到的实例数

---

## 6. 实测流程建议

1. **关掉 DevTools**
2. 浏览器开到最大化（标准化窗口尺寸）
3. 等 5 秒让 V8 JIT 预热
4. 按 F1，记录 FPS 稳定后的数值 + 其他指标
5. 按 F2、F3、F4、F5 同样操作
6. 把数据填到 §2 表格
7. 在 §3 打票
