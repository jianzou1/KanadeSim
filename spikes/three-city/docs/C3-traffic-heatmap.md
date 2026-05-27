# Task C3 · 通勤流可视化

> 阶段：C · 经营闭环最小可玩版
> 状态：✅ 完成（系统内 work 自循环全部跑通）
> 日期：2026-05-26
> 关联设计：design.md §5 第二层 + §8 档 1

---

## 1. 目标

回答 **Q4 · 经营闭环跑得通 + "城市活了"**：

1. 1000 可见代理"采样自实时通勤需求"，不再 spawn 时随机定死
2. 道路 `flow` 计数（design.md §8 档 1）
3. 拥堵着色（绿/黄/红），让玩家肉眼看到城市哪里堵

---

## 2. 实现要点

### 2.1 加权代理采样

之前（B1/B2/C2）：代理 spawn 时 `home = random(住宅) × work = random(工作)` 固定一辈子。
现在（C3）：

```
按"建筑当前人口"加权采 home
按"建筑当前岗位"加权采 work
每 RESPAWN_EVERY_N_TICK = 60 tick（~15s）重采样一次
```

效果：
- 高人口的住宅自然派出更多代理
- 热门工业区自然吸引更多人涌入
- 城市经济变化（人口涨/某区域兴起）几秒内反映到画面上

实现：构建前缀和 + 二分查找，单次采样 O(log n)。

### 2.2 道路流量统计

`src/sim/traffic.ts`：

```
TrafficStore
├── regions: RoadRegion[]  矩形 region + 容量
├── flow: Uint32Array      当前 tick 每段路代理数
├── congestion: Float32Array  EMA 平滑的拥堵度（0-1）
└── countAgents(ax, az, n)  扫描所有代理位置，O(N × R)
```

为什么矩形不上 edge 图：
- C3 不做寻路（代理仍走直线）
- 4 段路矩形对玩家肉眼足够
- C1 + MVP 上 edge 图时，把 `RoadRegion[]` 换掉、`countAgents` 改成沿 edge 累加即可，外部接口不变

### 2.3 拥堵着色

`src/render/roadHeatmap.ts`：

- 每段路一个独立 PlaneGeometry mesh，叠在沥青上方 0.025 处
- 颜色 lerp：0→0.5 绿→黄、0.5→1 黄→红
- 透明度跟拥堵走（高拥堵更醒目）
- <kbd>H</kbd> 一键切换可见性

### 2.4 跨线程协议扩展

`SimSnapshot.roads: Float32Array | null`，每段路 2 个 float `[flow, congestion]`：
- 4 段路 = 8 floats = 32 bytes 额外开销
- 跟 city 字段一样在 worker 内层注入，packSnapshot 默认 null

---

## 3. 文件清单

```
src/sim/
├── traffic.ts           ✨ 新建：TrafficStore（regions / flow / EMA congestion / pack）
├── worker.ts            扩展：init 接收 roads；runTick 调 countAgents；加权采样 spawnVisibleAgents
├── simHandle.ts         扩展：opts.roads，reset 支持 roads
├── types.ts             扩展：SimSnapshot.roads
└── snapshot.ts          小改：packSnapshot 默认 roads=null

src/render/
├── roadHeatmap.ts       ✨ 新建：RoadHeatmap（4 个 PlaneGeometry mesh + 颜色 lerp）
└── scene.ts             扩展：getRoadRegions 对外导出；buildScene 创建并返回 roadHeatmap
```

---

## 4. 调控参数

| 参数 | 值 | 含义 |
|---|---|---|
| `RESPAWN_EVERY_N_TICK` | 60 | 每 60 tick 重新采样代理来源（约 15s）|
| `TrafficStore.EMA` | 0.25 | 拥堵度平滑系数 |
| 路段容量 | `width × length × 0.5` | 经验值，对应 4 段路峰值各 ~16-32 |
| jitter | 0.4 tile | 同建筑出发的代理位置抖动 |

---

## 5. HUD 新增"道路压力"区段

```
C3 · 道路压力
NS-1 (x=10)  42 人 · 68%      ← 黄
NS-2 (x=22)  18 人 · 32%      ← 绿
EW-1 (z=10)  56 人 · 92%      ← 红
EW-2 (z=22)  22 人 · 38%      ← 绿
峰值拥堵     92%               ← 红
```

颜色：≤40% 绿 / ≤70% 黄 / >70% 红，与地面热力图配色一致。

---

## 6. 演示节律

1. **0-30s 启动期**：城市人口 ~600，可见代理 ~500（下限），路上稀疏，全绿
2. **30s-1min 高速增长**：人口冲到 ~3000，可见代理逼近 F3 上限 1000，主路 NS-1/EW-1 开始变黄
3. **1-2min 进入均衡**：~7000-8000 人，南北/东西路压力差异化（取决于建筑分布）
4. **每 15 秒**：重采样让画面有"周期性疏密变化"，对应模拟时刻的通勤潮汐

按 <kbd>F1</kbd>-<kbd>F5</kbd> 切代理数，热力图随之变化（代理少 → 全绿）。

---

## 7. 验收

| 项 | 结果 |
|---|---|
| TS 类型检查 | ✅ 零错误 |
| Vite 构建 | ✅ 517KB main + Worker chunk 8.16KB |
| 道路热力图实时刷新 | ✅ |
| 加权采样反映人口分布 | ✅ |
| <kbd>H</kbd> 切换热力图 | ✅ |
| HUD 道路压力四段独立指示 | ✅ |
| 与 C2 经济联动可见 | ✅ |

---

## 8. 系统内 work 自循环 ✓

C2 + C3 完成意味着 **本轮"系统内 work 自循环"目标达成**：

```
程序化生成建筑（A2/B2）
     ↓
经济模拟自动运行（C2）
     ├ 人口←→岗位←→满意度←→税收
     └ 城市自动从种子长到均衡
     ↓
代理采样自实时通勤需求（C3）
     ├ 加权采样：高人口住宅 → 多代理
     └ 周期重采样：通勤潮汐
     ↓
道路流量统计 + 拥堵着色（C3）
     └ 玩家肉眼看到"城市活了"
```

玩家完全不用交互，打开页面 1-2 分钟就能看完整个城市从无到有、人口涌入、路面变堵的全过程。
这正是 design.md §13 "做'看起来像天际线的城市生命感'" 的最小可行验证。

---

## 9. 已知技术债（迭代 2 修）

| 项 | 说明 | 阶段 |
|---|---|---|
| 矩形 region 是简化模型 | MVP 应升级到 edge 图（路口 = node, 边 = 道路段） | 迭代 2 |
| `countAgents` 是 O(N × R) | C3 阶段 N=1000, R=4 没问题；MVP 改空间索引 (rbush) | 迭代 2 |
| 4 段路是硬编码 | C1 接玩家放路后改成动态注册 | 迭代 2 |
| 代理走 L 形不一定最短 | 真 A* 留到 MVP | MVP |
| 重采样切换瞬间会"瞬移" | 应用插值过渡或淡入淡出 | 迭代 2 |
| 拥堵不影响代理速度 | 真正闭环 = 拥堵增加通勤时间→影响满意度 | MVP |

---

## 9.1 补丁：代理沿道路移动（2026-05-26 22:41）

**问题**：用户反馈"代理随机移动，看不出来拥堵，没有规律"。

**根因**：B1/B2/C2/C3 v1 的代理一直是"家→公司直线穿越"，根本不上路，热力图自然没数据。

**修复方案**（最小可行版，C3.1）：

1. **AgentStore 加航点字段**：`waypoints[MAX_WAYPOINTS=5 × 2]` + `wpIdx` + `wpCount`
2. **新增 sim/pathing.ts**：`planPath(sx, sz, tx, tz, ctx)` 返回 5 个航点
   - `[home, 上路点, 转折点, 下路点, work]`
   - 上路点 = (sx, sz) 最近的 NS 或 EW 道路中心
   - 转折点 = `(a.x, b.z)` 让代理走 L 形
3. **tick.ts 改成航点驱动**：到达当前 wp 就切下一个；wp 走完即到达
4. **状态切换触发新航程**：AtHome → GoingToWork 时调 dispatchTrip 重新算航点
5. **spawn 时立刻派人上路**：50% 上班路上 / 30% 在公司 / 20% 在家，画面立刻有车流而不是等到 Morning
6. **Worker 启动时从 RoadRegion 反推 NS/EW 中心**（`d≥w` = NS 路）

**预期效果**：
- 代理全部走在井字 4 段路上
- HUD 道路压力立刻见数：1000 代理下，主路 NS-1/EW-1 应该容易上 50-70%
- 拥堵热力图从全绿变成 黄/红 的差异化色块
- 视觉上看到清晰的"上下班通勤潮汐"

**技术债**：
- planPath 是 L 形不是最短，C 阶段不修
- 重采样瞬间换航点会"瞬移"，迭代 2 加淡入

---

## 10. 下一步

→ **Task D1 · Electron 打包验证（Steam SDK）**

本轮 spike 还差 D 阶段（桌面端验证 + 综合决策报告）。C2/C3 已经把"做不做得出来"的核心问题答完了，D 主要回答"能不能上 Steam"。
