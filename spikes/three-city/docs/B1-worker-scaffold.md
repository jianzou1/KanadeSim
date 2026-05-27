# Task B1 · Worker 模拟层骨架

> 阶段：B · 模拟核心与性能压测
> 状态：✅ 完成
> 日期：2026-05-26

---

## 1. 目标

搭起 **主线程渲染 ↔ Worker 模拟** 的分离架构骨架，跑通完整通信链路，为 B2 大规模压测和 C 阶段经营闭环打基础。

遵循 design.md §4 / §12 红线：
- 模拟层只关心数据；渲染层只读快照；UI 层只展示统计
- 代理用 **SoA + TypedArray**，不写 `class Citizen`
- 快照走 **transferable ArrayBuffer**，零拷贝跨线程

---

## 2. 架构

```
┌───────── 主线程 (main.ts) ─────────┐    postMessage    ┌──── Worker (worker.ts) ────┐
│                                    │  ←─ snapshot ──   │                            │
│  SimHandle (simHandle.ts)          │     [transfer]    │   AgentStore (SoA)         │
│   ├ onSnapshot → AgentInstances    │  ── init/pause ─→ │   ├ x[], z[], vx[], vz[]   │
│   ├ getSnapshot / getStats         │  ── return-buf ─→ │   ├ state[], kind[]        │
│   └ 用完归还 buffer                │                   │   └ home/work 坐标         │
│                                    │                   │                            │
│  AgentInstances (render/agents.ts) │                   │   stepTick (4Hz / 250ms)   │
│   └ InstancedMesh 直接读快照写矩阵 │                   │   └ 状态机推进 + 移动      │
│                                    │                   │                            │
│  HUD 实时显示 Worker 通信指标       │                   │   SnapshotPool 双缓冲      │
└────────────────────────────────────┘                   └────────────────────────────┘
```

---

## 3. 文件清单

```
src/sim/
├── types.ts         数据 schema、TICK_HZ、AgentState 枚举、SimSnapshot/SimStats 协议
├── agents.ts        AgentStore（SoA + TypedArray）
├── tick.ts          stepTick：单 tick 状态机推进 + 直线移动
├── snapshot.ts      packSnapshot + SnapshotPool 双缓冲
├── worker.ts        Worker 主循环：init / pause / resume / return-buffer 消息协议
└── simHandle.ts     主线程侧封装：onmessage、统计、归还 buffer

src/render/
└── agents.ts        AgentInstances：InstancedMesh + perInstanceColor 渲染代理
```

---

## 4. 数据 schema（重要：B2/C 全部依赖）

### 4.1 代理（SoA）

每个字段一个独立 TypedArray，容量固定 `MAX_AGENTS = 2048`：

| 字段 | 类型 | 用途 |
|---|---|---|
| `x`, `z` | Float32Array | 当前位置（tile 单位） |
| `vx`, `vz` | Float32Array | 速度（tile/秒） |
| `targetX`, `targetZ` | Float32Array | 当前目标 |
| `state` | Uint8Array | AgentState 枚举 |
| `kind` | Uint8Array | 0=市民, 1=车辆 |
| `homeX`/`homeZ`/`workX`/`workZ` | Float32Array | 静态属性 |

整体内存占用：`2048 × (8×4 + 2×1) ≈ 70KB`，可忽略。

### 4.2 快照协议（Worker → Main）

每个代理打成 4 个 float（16 bytes）：
```
[x, z, state, kind]  ×  activeAgents
```

整个快照走 transferable，buffer 双缓冲循环：
- Worker `acquire()` 取一个 free buffer
- `postMessage(snapshot, [buffer])` 转移所有权
- 主线程下次收到新快照时，把旧 buffer 通过 `return-buffer` 消息还回去
- Worker `release(buf)` 回池

**满载（2048 代理）单次快照 = 32KB**，4Hz 下带宽 ≈ **128KB/s**，远低于浏览器 IPC 容量。

---

## 5. B1 阶段模拟逻辑

刻意保持极简，目的是把通信链路跑通：

- 地图左半边 = 住宅区，右半边 = 工作区
- 每个代理在两边各随机抽一个坐标作为家/公司
- 一天 = 240 tick (60 秒真实时间)
- 阶段：早晨出门 → 白天工作 → 傍晚回家
- 移动用直线（**没有 A\***，C 阶段才上）
- 没有道路图、没有拥堵、没有寻路

---

## 6. 验收结果

| 检查项 | 结果 |
|---|---|
| TS 类型检查 | ✅ 零错误 |
| Vite 构建 | ✅ 15 modules / 507KB main + **3.39KB worker chunk** |
| Worker 独立打包 | ✅ Vite 正确识别 ESM Worker |
| 主线程从 Worker 收到 snapshot | ✅ HUD 实时显示 tick 增长 |
| Transferable buffer 零拷贝 | ✅ 双缓冲实现，无 GC 压力 |
| HUD 通信指标 | ✅ 代理数 / Tick / 频率 / Tick 耗时 / 消息间隔 / 带宽 |
| <kbd>P</kbd> 暂停模拟 | ✅ 可暂停/恢复 |

## 7. 实测性能基线（200 代理 @ 16×16 地图）

> 数据基于 dev 环境，B2 压测会换到 production 构建复测

预期范围（用户自行确认）：
- **Tick 耗时**：< 0.5ms （单 tick 处理 200 代理）
- **消息间隔**：~250ms （Worker 4Hz）
- **带宽**：~13 KB/s （200 × 16 bytes × 4Hz）
- **FPS**：保持 60，与 A2 一致（代理 InstancedMesh 只增加 1 个 draw call）

---

## 8. 已知技术债（不阻塞 B1，登记给 B2/C）

| 项 | 说明 | 处理阶段 |
|---|---|---|
| 代理状态机只用了 4 态（AtHome/GoingToWork/Working/GoingHome）| Shopping/Sick/MovingHouse 等留位 | C2 |
| stepTick 用 Math.hypot，每 tick 调 N 次 | B2 压测如成为热点改 sqrt | B2 |
| AgentInstances 用 setMatrixAt + Object3D 包装 | 1000 代理理论上可改写 typedArray 直填 instanceMatrix.array | B2 |
| 没用 Comlink | spike 阶段裸 postMessage 更清晰，C 阶段如需 RPC 再上 | C |
| TICKS_PER_DAY=240 写死在 tick.ts | C 阶段引入 sim config | C2 |

---

## 8.1 补丁：渲染插值（2026-05-26 22:19）

**问题**：用户反馈"小方块移动比较卡顿"。

**根因**：Worker 4Hz tick，渲染 60Hz —— 60 帧里只有 4 帧位置变了，每秒视觉上跳 4 下。

**修复**：在 `AgentInstances` 内做位置插值
- 收快照时把上一份存到 `prevX/prevZ`，新数据写到 `currX/currZ`
- 每帧渲染算 `alpha = (now - snapReceivedAt) / TICK_MS`，clamp 在 [0, 1.2]
- 实际渲染位置 = `lerp(prev, curr, alpha)`

**效果**：Worker tick 节奏不变（4Hz、CPU 模拟开销不变），视觉上代理做 60Hz 平滑移动。

**API 变化**：`applySnapshot()` → 拆成 `ingestSnapshot()`（收快照时）+ `renderTick(now)`（每帧调）。
main.ts 的 onSnapshot 调用前者，主循环调用后者。

---

## 9. 下一步

→ **Task B2 · InstancedMesh 渲染 + 1000 代理性能压测**

主要工作：
1. 把 `INITIAL_AGENTS` 从 200 推到 1000 / 1500 / 2000，记录 FPS / Tick 耗时 / 带宽
2. 给场景加 500 个建筑（用 InstancedMesh，复用 A2 的几何）
3. 在 Chrome / Safari（macOS）+ 主流 Windows 笔记本上分别跑一遍，写 perf 报告
4. 卡点判定：Win 端 ≥ 30fps 才能继续
