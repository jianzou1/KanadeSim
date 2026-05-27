# 迭代 2 计划 · 通勤模拟向 CS2 看齐

> 起点：迭代 1 已通过 C2/C3 跑通"系统内自循环"。
> 目标：把 4 段矩形路 + L 形航点的"装饰性通勤"升级到 **真道路图 + 时间成本 + 拥堵反馈 + 潮汐节律**。
> 北极星：**1-2 分钟内能肉眼看出"早高峰主路堵 → 满意度下降 → 玩家拓宽路 → 通勤时间下降 → 满意度回升"。**
> 关联：`design.md §14`（CS2 通勤参照）；`docs/C3-traffic-heatmap.md §9`（已知技术债）。

---

## 1. 与 CS2 的差距盘点

迭代 1 实际跑通的：

```
程序化建筑 → C2 经济（人口/岗位/满意度/税收）
            → C3 通勤（加权采样 + L 形航点 + 4 段路矩形 region 流量）
            → 拥堵热力图（绿/黄/红）
```

差在哪：

| 维度 | 迭代 1 现状 | CS2 做法 | 迭代 2 目标 |
|---|---|---|---|
| 道路结构 | 4 段路矩形 region 硬编码 | 路口=node，道路段=edge | **edge 图 + Dijkstra/A*** |
| 寻路 | L 形航点（home → 上路点 → 拐点 → 下路点 → work） | 基于成本（时间/舒适度/金钱/行为） | **time + comfort 二要素**，预留 money/behavior |
| 拥堵反馈 | 只染色，不影响代理速度 | 拥堵 → 边权 → 路线选择 + 通勤时间 → 福祉 | **拥堵入边权 + 拉长通勤 + 满意度** |
| 时间节律 | 全天均匀 spawn | 早高峰/晚高峰 + 闲时娱乐 | **24h 时钟 + 上下班潮汐** |
| 代理生成 | 每 60 tick 整批重采样 → 瞬移 | 每个 cim 独立日程 | **航点平滑过渡 + 错峰 spawn** |
| 路况-事故-救援闭环 | 无 | 有 | 不做（MVP/正式版） |
| 多车道/停车/年龄段 | 无 | 有 | 不做（MVP/正式版） |
| 公共交通 | 无 | 有 | 不做（MVP/正式版） |

---

## 2. 任务列表（按推荐顺序）

按"先地基后表现"的顺序，每个任务都尽量保留迭代 1 的 sim/render 分层。

### Task E1 · 道路图（RoadGraph）

**目标**：把硬编码 4 段路换成可动态注册的节点-边图。

**产出**：

```
src/sim/roadGraph.ts （新建）
  ├ Node: { id, x, z }
  ├ Edge: { id, from, to, length, capacity, speed, flow, congestion }
  ├ 邻接表 + 端点空间索引（最近 node 查询）
  ├ buildFromRegions(...) 兼容 C3 的 4 段路初始化（不改外部表现）
  └ 提供 fastestPath(srcNodeId, dstNodeId, costFn) → Edge[]

src/sim/traffic.ts
  └ TrafficStore 改成沿 edge 累加，countAgents 沿 edge 投影
src/render/roadHeatmap.ts
  └ 改成 per-edge 上色（不再是 4 个硬编码 mesh）
```

**验收**：

- 现有 C3 表现不变（4 条路染色一致）
- F2/F4 切代理数热力图行为不变
- TS 类型检查通过、Vite 构建通过

> 这一步是地基，不引入新画面，但为后面所有事让路。

---

### Task E2 · Dijkstra 寻路 + 路径缓存

**目标**：替换 `pathing.ts` 的 L 形航点，让代理按 edge 序列走。

**产出**：

```
src/sim/pathing.ts
  ├ 删 planPath 的 L 形实现
  ├ 新 planPath(srcBuildingId, dstBuildingId, ctx) → Edge[] | walkOnly
  ├ 路径缓存：key = (srcNode, dstNode)，graph 拓扑变才失效
  ├ 寻路队列：每帧最多 N 个新请求，超出则下一帧
  └ 同 OD 复用：同一 home/work 对的代理共享 path
src/sim/agents.ts
  ├ AgentStore 改成 edgeSeq + edgeIdx + tOnEdge（0-1 在边上的位置）
  └ 渲染坐标 = lerp(edge.from, edge.to, tOnEdge)
src/sim/tick.ts
  └ 推进 tOnEdge += speed × dt / edge.length；t≥1 → 切下一 edge
```

**成本函数（迭代 2 简版）**：

```ts
edgeCost(e, ctx) {
  const time = e.length / Math.max(0.1, e.speed * (1 - 0.6 * e.congestion))
  const comfort = ctx.lastTurn ? TURN_PENALTY : 0
  return time + comfort
}
```

`comfort` 现阶段只惩罚转弯（夹角 > 阈值），不做停车 / 路面状况；`money/behavior` 全 0 占位。

**验收**：

- 代理沿真路网 edge 走，不再是直线
- 关停寻路缓存（debug 开关）后还能跑（证明缓存只是优化）
- 代理数 1000 时主线程 <1ms / Worker tick <8ms（B2 基线之内）

---

### Task E3 · 拥堵 → 边权 → 闭环反馈

**目标**：把 C3 的染色拥堵接进决策环。三件事：

1. **拥堵进边权**（在 E2 公式里已经放进 `e.speed * (1 - 0.6 * congestion)`，这里只做调参 + 验证）
2. **拥堵拉长实际通勤**：代理在 edge 上的速度由 `edge.speed × (1 - α × congestion)` 调制
3. **通勤时间反馈到满意度**：

```
avgCommute = 城市最近 N 次到达 work 的平均 trip time
住宅满意度修正 = -k × max(0, (avgCommute - target) / target)
```

**产出**：

```
src/sim/economy.ts
  └ 加入 commute satisfaction term；HUD 暴露 avgCommute
src/sim/traffic.ts
  └ congestion EMA 调到 0.15（更慢响应，避免抖动闪烁）
src/sim/pathing.ts
  └ 限频重规划：代理路径成本超阈值 + 冷却 ≥ 30 tick 才重算
```

**验收**：

- 主路堵到 80%+ 时，HUD 上"平均通勤"明显抬头
- 平均通勤抬头后，住宅满意度肉眼下降（颜色变黄）
- 玩家把堵的路改成更宽（手动调 edge.capacity）后，看到反向回落

> 这是**整个迭代 2 的核心反馈环**，没这步就跟迭代 1 没区别。

---

### Task E4 · 24h 时钟 + 早晚高峰潮汐

**目标**：让通勤有"时段感"，而不是 24/7 均匀流动。

**产出**：

```
src/sim/clock.ts （新建）
  ├ SimClock: { tick, dayOfWeek, hourOfDay }
  ├ 1 模拟日 = 480 tick（约 2 分钟实时，4Hz）
  └ 提供 isMorningRush / isEveningRush / isLeisureWindow

src/sim/agents.ts
  ├ 每个可见代理拿一个个人 leaveHomeHour（高斯分布在 6.5-8.0）
  └ 状态机：AtHome → 时间到 → GoingToWork → AtWork → 时间到 → GoingHome
src/sim/worker.ts
  └ spawnVisibleAgents 改成"按时段需求生成"，不再 60 tick 一刀切重采样
src/ui (HUD)
  └ 显示当前时刻 + 当前阶段（rush / leisure / night）
```

**验收**：

- 06:00–09:00 主路 NS-1/EW-1 拥堵明显高于其他时段
- 16:00–19:00 反向再来一次
- 22:00–05:00 路上稀疏，热力图近全绿
- 重采样不再"瞬移"——代理切换状态在家门口/公司门口完成

---

### Task E5 · 时间倍速 + 暂停

**目标**：spike 阶段固定 4Hz 在迭代 2 已经不够（一天 2 分钟太慢看潮汐对比），加 1x/2x/4x/暂停。

**产出**：

```
src/sim/simHandle.ts
  ├ setSpeedMultiplier(0 | 1 | 2 | 4)
  └ Worker 端用 RAF 自驱时变成 setInterval(tickPeriod / mult)
src/ui
  └ 空格暂停 / 1/2/4 切倍速；HUD 显示当前倍速
```

**验收**：

- 4x 下一天 = 30s，潮汐对比 30s 内能看完
- 暂停时 HUD 数据不动、画面静止

---

### Task E6 · 决策报告 + 视频

**目标**：把"我们离 CS2 通勤还差什么"用一段 1-2 分钟视频和一篇 markdown 总结掉，决定 MVP 是否启动。

**产出**：

```
docs/E6-iteration-2-report.md
  ├ E1-E5 实现要点
  ├ 性能数据（1k/2k/3k 代理对比）
  ├ 与 CS2 的差距清单（哪些"形似"，哪些"还没做"）
  └ MVP 是否启动的判断（GO / NO-GO）

assets/iteration-2-demo.mp4 （或 GIF）
  └ 30s 录屏：城市从启动 → 早高峰 → 玩家拓路 → 拥堵下降
```

---

## 3. 不在迭代 2 做的（明示）

按 design.md §14 的判断，下面这些放 MVP 或正式版：

- **多车道 / 变道 / 红绿灯**：edge 图够了，车道是表现层升级
- **停车位作为资源**：要先有公共交通对照才有意义
- **年龄段权重（Teen/Adult/Senior）**：要先有家庭/年龄字段
- **家庭购物循环**：要先有"商品/资源"系统
- **公共交通（公交/地铁）**：MVP 单独立项
- **事故 + 道路养护**：要先有服务车辆派遣
- **服务车辆按未来位置调度**：先要有服务建筑

迭代 2 只追"通勤这一段往 CS2 靠"，其他不动。

---

## 4. 时间预估（粗略）

| 任务 | 估时 | 风险 |
|---|---|---|
| E1 道路图 | 1-2 天 | 中（要兼容 C3 表现） |
| E2 Dijkstra + 缓存 | 2-3 天 | 中（性能、瞬移、缓存失效都要试） |
| E3 拥堵闭环 | 1-2 天 | 高（调参手感是最难的，反馈太快/太慢都不行） |
| E4 时钟 + 潮汐 | 1-2 天 | 低 |
| E5 时间倍速 | 0.5-1 天 | 低 |
| E6 报告 + 视频 | 0.5 天 | 低 |
| **合计** | **6-10 天** | — |

---

## 5. 验收线（迭代 2 整体）

迭代 2 整体过线条件，挑一条肉眼能演示的：

> 打开页面，按 4x 倍速。看到城市从无到有；进入第二天早高峰时，主路 NS-1 染红，HUD"平均通勤"从 8s 涨到 22s，"住宅平均满意度"从 82% 跌到 71% 显示橙色；暂停，把 NS-1 的容量手动 ×2（模拟玩家拓路），继续；下一个早高峰时，NS-1 还是黄色但不再红，平均通勤回到 12s，满意度回到 78%。

只要这个剧本能复现，迭代 2 就算过线。
