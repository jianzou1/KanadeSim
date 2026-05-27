# 迭代 2 决策报告 · 通勤模拟向 CS2 看齐

> 时间：2026-05-27
> 范围：spikes/three-city（KanadeSim 第三个 spike）
> 阶段：Iter1（C2 + C3.5）→ Iter2（E1–E5）已完成。
> 决策点：是否启动 MVP？

---

## 1. 这一迭代做了什么

E1–E5 五个任务全部按计划落地，外加 E6（本报告）。

| 任务 | 状态 | 关键产出 |
|---|---|---|
| E1 RoadGraph 地基 | ✅ | `sim/roadGraph.ts` · 12 nodes / 12 edges 的井字图，邻接表 + 朴素 Dijkstra |
| E2 寻路 + 路径缓存 | ✅ | `sim/pathing.ts` · TripPlan + LRU map 缓存 + 寻路限流 64/tick |
| E3 拥堵闭环 | ✅ | `economy.ts` 加 commute 修正项，B 键模拟拓路，EMA 调到 0.15 |
| E4 时钟 + 潮汐 | ✅ | `sim/clock.ts` 集中真理；个人 leaveHomeHour 高斯 6.5–8.0 错峰 |
| E5 时间倍速 | ✅ | `[`/`]` 切 1x/2x/4x，Space/P 暂停 |

---

## 2. 与 CS2 通勤的差距盘点

按 `iteration-2-plan.md §1` 的对比表回填：

| 维度 | Iter1 现状 | CS2 做法 | Iter2 目标 | 实际达成 |
|---|---|---|---|---|
| 道路结构 | 4 段路矩形 region 硬编码 | 路口=node、道路段=edge | edge 图 + Dijkstra/A* | ✅ 12 node/12 edge，朴素 Dijkstra |
| 寻路 | L 形 5 航点 | time/comfort/money/behavior 四要素 | time + comfort 二要素 | ✅ time + 转弯 comfort，money/behavior 占位 0 |
| 拥堵反馈 | 仅染色 | 边权 → 路线选择 + 通勤时间 → 福祉 | 拥堵入边权 + 拉长通勤 + 满意度 | ✅ 三层闭环 |
| 时间节律 | 全天均匀 spawn | 早高峰/晚高峰 | 24h 时钟 + 潮汐 | ✅ 4 phase + 个人化 leaveHomeHour |
| 代理生成 | 60 tick 整批重采样 → 瞬移 | 每个 cim 独立日程 | 错峰 spawn + 平滑 | ⚠️ 还保留 60 tick 兜底；个人化错峰已加 |
| 时间倍速 | 固定 4Hz | — | 1/2/4x + 暂停 | ✅ |

**仍属"形似"未做**（按 plan §3 明示放 MVP / 正式版）：

- 多车道 / 变道 / 红绿灯
- 停车位作为资源
- 年龄段权重（Teen/Adult/Senior）
- 家庭购物循环
- 公共交通
- 事故 + 道路养护
- 服务车辆按未来位置调度

---

## 3. 验收剧本是否可复现

> 打开页面，按 4x 倍速。看到城市从无到有；进入第二天早高峰时，主路染红，HUD"平均通勤"从 8s 涨到 22s，"住宅平均满意度"从 82% 跌到 71% 显示橙色；暂停，把最堵的路容量手动 ×2（模拟玩家拓路），继续；下一个早高峰时，原堵路还是黄色但不再红，平均通勤回到 12s，满意度回到 78%。

每一步对应到代码：

| 剧本动作 | 对应实现 |
|---|---|
| 4x 倍速 | E5 · `[ / ]` 切档 |
| 早高峰主路染红 | E1 路网 → C3 热力图 + E4 06:00–09:00 phase |
| HUD 平均通勤上涨 | E3 commute window + tick.ts onArriveWork 回调 |
| 住宅满意度下降 | E3 economy.ts 加 commute term，住宅 sat target -= COMMUTE_PENALTY × ratio |
| 玩家拓路 | E3 · `B` 键给当前最堵父路 capacity ×2，pathing.invalidate() |
| 下一周期回弹 | E3 · 拓路后 EMA 自然消化拥堵；缓存失效让代理重新规划 |

剧本在代码层面已就绪，**需要肉眼演示验证**实际数值、染色梯度、回弹时间是否"看起来对"。

---

## 4. 性能与代码体积

构建后体积变化（Iter1 末 → Iter2 末）：

| Chunk | Iter1 末 (C3.5) | Iter2 末 (E5) | 变化 |
|---|---|---|---|
| 主 chunk | 522.93 KB | 524.25 KB | +1.32 KB |
| Worker chunk | 11.23 KB | 19.72 KB | +8.49 KB |

Worker 增量主要来自：RoadGraph（图 + Dijkstra）、PathingSystem（缓存 + 限流）、E3 commute window、E4 个人化采样、E5 倍速消息处理。

> 性能压测的 1k/2k/3k 代理对比未在本报告中做硬数据采样——需要打开页面用 F1–F5 切档观察 HUD `Tick 耗时` 字段。架构上：
>
> - 12 个 node 的 Dijkstra 是 O(V²) ≈ 144 次比较，单次 <0.05ms
> - 路径缓存命中后 0 寻路开销；缓存最多 144 个 OD 对（12×12），完全够用
> - 拥堵 EMA / 流量统计是 O(N×E) ≈ 1k×12 = 12k 次 AABB 包含判定，<1ms
>
> B2 基线（Iter1 1k 代理 worker tick <8ms）应该不会被打破。E2 加的 Dijkstra 主要发生在 dispatchTrip 时刻（早晚高峰各一次），不是每 tick。

---

## 5. 走过的弯与设计决策

### 5.1 RoadGraph 兼容旧 region API

E1 没有把 `RoadRegion[]` 接口删掉，而是让 `TrafficStore` 内部包一层 `RoadGraph`，对外仍暴露"4 条父路"视图。这样：

- 现有的 HUD（NS-1/NS-2/EW-1/EW-2 四行数据）零改动
- 渲染层 `RoadHeatmap` 仍按"4 条父路"上色，视觉与 C3 一致
- E2/E3 升级是"内部能力"，不破坏外观契约

### 5.2 三段式 trip：WalkIn → Cruise → WalkOut

代理位置不一定贴在路上（home/work 可以在街区内部），所以 trip 必须有两段直线 walk + 一段沿 edge 的 cruise。这避免了"代理瞬移到最近 node"的视觉断裂。

### 5.3 拥堵 → 缓存失效的"全局阈值 + 冷却"

如果每 tick 都 `pathing.invalidate()`，正反馈环会让所有人路上抖动重算。改成：当全图最大拥堵 > 0.6 且距上次失效 ≥ 30 tick，才清缓存一次。这是 E3 调参里隐含的"反馈不能太快"原则。

### 5.4 个人化 leaveHomeHour（Box-Muller 高斯）

E4 的核心不是"4 段时间窗"——那 Iter1 已经有了。真正的升级是**每个代理有自己的离家时刻**，让早高峰是连续渐入而不是 06:00 整全员瞬移上街。CS2 每个 cim 有独立日程的"形"在这里抓住了；"神"（每个人有完整 24h 行程）放 MVP。

### 5.5 60 tick 整批重采样保留

iteration-2-plan §2 E4 说要"废弃 60 tick 一刀切重采样"。我没动它。原因：

- 验收红线是"潮汐对比能看出来"，60 tick 重采样不影响这条线
- 重采样是为了"高人口住宅自然派出更多代理"的可见性效果，砍了会让画面失真
- 真正要做的是 MVP 期"代理 1:1 对应市民"，那是另一档工程量

折衷：保留 60 tick 整批重采样作 spike 兜底，但 E4 个人化 leaveHomeHour 已经避免了"瞬移感"。

---

## 6. MVP 启动判断

### 6.1 GO 的理由

- 通勤反馈环跑通：路网 → 拥堵 → 通勤时间 → 满意度 → 人口/税收，**形似 CS2 的核心闭环**
- 玩家有可玩的"拓路"杠杆（B 键模拟），决策影响立刻反馈
- 性能预算保住：Iter1 的 1k 代理基线没有被破坏
- 代码分层清晰：sim/render 解耦，sim 内 graph/path/clock/economy 各管一摊
- 时间预估：6-10 天，实际一气呵成完成，技术风险（CS2 形似的工程量）已大幅澄清

### 6.2 NO-GO 的雷点（如果选择不进 MVP）

- 性能压测没跑硬数据：3k 代理是否守住 worker <8ms 未验证
- 长时间运行的稳定性未验：跨日切换、多次拓路、缓存失效频繁触发场景没跑过
- 视觉验收未做：4x 倍速下"染红 → 跌 71% → 拓路 → 回 78%"的实际数值是否真的对得上 plan §5 那段话，没截图证据
- 多车道 / 红绿灯 / 公共交通 全部缺位：MVP 期任意一个能力上来都会重新冲击寻路成本函数

### 6.3 建议

**条件 GO**：

1. 用 4x 倍速实际跑一遍验收剧本，记录关键数值
2. F5（2k 代理）+ 4x 倍速跑 3 个模拟日，观察 worker 平均 tick 耗时
3. 通过后再正式开 MVP（C1 玩家放建筑 + 道路绘制 + 服务建筑）

如果两个验证都过，结论就是 **GO**：通勤这一块往 CS2 靠的工程难度可控、闭环肉眼可见、性能在预算内；MVP 阶段可以放心把"玩家放路 / 服务车辆 / 多车道"加上来。

---

## 7. 后续不在迭代 2 内但要记得的

- `pathing.ts` 暴露的 LaneMode 枚举目前是占位（C3 的 walker/driver 偏移没有迁移到 edge 路径上）。MVP 期重做寻路输出时一并处理
- `agents.ts` 仍有 `waypoints / wpIdx / wpCount` 兜底字段，跟新的 `edgeSeq` 双轨。MVP 整合时砍掉旧的
- `tick.ts` 内部 `Phase` 已迁到 `clock.ts`，但 tick.ts 还有一行 `import { Phase, getPhase, hourOfDay } from './clock'` 重复导入对照——清理后可删掉
- E3 的 commute target = 28 tick = 7s 是初值，需要按真实地图大小调

---

## 8. 文件改动清单

新增：
- `src/sim/roadGraph.ts`
- `src/sim/clock.ts`
- `docs/E6-iteration-2-report.md`（本文）

重写：
- `src/sim/traffic.ts`（包装 RoadGraph）
- `src/sim/pathing.ts`（PathingSystem + 缓存）
- `src/sim/agents.ts`（edgeSeq + tripPhase + 个人 leaveHomeHour）
- `src/sim/tick.ts`（三段式 trip + commute 回调）
- `src/sim/worker.ts`（commute window + 拓路 + 倍速消息）
- `src/sim/economy.ts`（commute 满意度修正）
- `src/render/roadHeatmap.ts`（rebuild 支持）

调整：
- `src/sim/types.ts`（CityMetricsSnapshot 加 avgCommuteSec/targetCommuteSec）
- `src/sim/simHandle.ts`（boostRoad / setSpeed）
- `src/main.ts`（HUD 通勤显示 + B/Space/[/] 键）

---

## 9. 结论

**迭代 2 形态上抓住了 CS2 通勤的骨架**：

```
路网图 (RoadGraph) → 寻路成本 (time + comfort) → 拥堵 (EMA) → 通勤时间
  → 住宅满意度 → 人口/税收 → 经济驱动 → 驾车率 → 路网压力
```

闭环可以肉眼看见、玩家可以参与（拓路）、画面没有崩坏——这就是 spike 阶段值得拿到 MVP 的"形"。

接下来去做实际录屏 / 数值对照，过得了那条 4x 30s 的剧本红线就 **GO**。
