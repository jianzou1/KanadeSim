# 迭代 3 计划 · 方向切换：从"城市经营"到"物流经营"

> 起点：迭代 2 已通过通勤+拥堵+24h 潮汐跑通"CS 风的活城"。
> 北极星：**一个会话内能肉眼看出"玩家铺路 → 连货链 → 货送到 → 城市长大；切断 → 城市萎缩"，全程不依赖任何 CS 反馈环。**
> 关联：`design.md §1`（方向选型）、`§4`（链 + 节点）、`§5`（城市受动）、`§9`（与迭代 1/2 的分手协议）。

---

## 1. 与"现状"的差距盘点

迭代 2 末态：

```
程序化建筑 → C2 经济（人口/岗位/满意度/税收）
            → 通勤代理（按时间-舒适度寻路）
            → 拥堵 → 边权 → 满意度 → 人口
```

迭代 3 目标态：

```
玩家铺路 + 玩家建产业 → TransportLine（货车跑 RoadGraph）
                       → 城市 TownDistrict.supplied 累加
                       → fulfillment → grow / shrink
                       → 街区变大 / 萎缩
```

差在哪：

| 维度 | 迭代 2 现状 | 迭代 3 目标 |
|---|---|---|
| 道路 | 程序化"井"字硬编码 | **玩家手动铺路 + RoadGraph 增量更新** |
| 经济驱动 | 居民满意度（CS） | **货物供给（TF）** |
| 城市增长 | C2 反馈 + M3 自生长（已落地，但驱动错） | **fulfillment 来源换成真实到货量** |
| 货物链 | 无 | 6 类货物 + 4 类产业 + 3 类城市 zone 终端 |
| 运输线 | 无 | **TransportLine + 货车 agent** |
| 通勤 agent | 模拟核心 | **降级为装饰性可见行人/小车** |
| 满意度反馈环 | 完整闭环 | **完全裁掉** |

---

## 2. 北极星验收脚本

迭代 3 完成的判定 = 下面这段操作能完整跑出来（10 分钟内）：

```
1. 在空白地图上落 1 个 Farm（自动产出 grain）
2. 在中等距离落 1 个 FoodPlant
3. 铺一条路把 Farm → FoodPlant 连起来
4. 创建运输线 Farm → FoodPlant，派 2 辆货车 → 看到 grain 被运走
5. 同样把 FoodPlant → 某城市商业区连起来
6. 等 1-2 分钟（≈ 1 游戏年）：
   • 商业区的某街区开始 grow（新建筑出现）
   • HUD 街区面板显示 fulfillment 从 0 升到 0.8+
7. 删除中间一段路：
   • 货车寻路失败 → 库存堆积 → 城市 supplied 归零
   • 6 个游戏月内街区开始 shrink（建筑减少）
8. 修复路 → 反弹回升
```

---

## 3. 任务列表（按推荐顺序）

### Phase 1 · 降级与裁剪（清旧账，1 天）

> 切方向先把旧的卸下来，不然后面的新东西会和旧反馈环互相干扰。

#### Task R1 · 裁掉 CS 反馈环

**改动点**：
- `sim/economy.ts`：删 `COMMUTE_PENALTY` 与 `commutePenalty` 相关分支；住宅 satisfaction 仅由"住房压力 + 失业率"驱动，**或更简单：把整套 satisfaction 改成"展示值"，不再影响人口**
- `sim/economy.ts`：人口增减改为"被 fulfillment 拉动"——暂时设为常数（每 tick 微涨），实际增长由 §M3 街区生灭间接体现
- `sim/worker.ts`：删 `recordCommute` 调用对 economy 的影响，但**保留 HUD 显示**（玩家还能看到通勤时长这个观察值）

**验收**：
- HUD 上"满意度"字段仍显示，但拖延通勤几分钟，住宅满意度**不再下降**
- F2/F4 切代理数，城市人口不应抖动

---

#### Task R2 · 通勤 agent 降级为"装饰"

**改动点**：
- `sim/worker.ts` 的 `spawnVisibleAgents` / `topUpAgents`：保留生成逻辑，但**目标数从"按城市人口"改为"按 § ${districts.length} × const"**——只服务视觉，不服务数值
- `sim/tick.ts` 的代理推进：保留 edge 走法
- 删 commute 窗口写入或保留但断开下游

**验收**：
- 画面上仍有行人/小车在街区间游走
- 关掉 sim 的城市自生长（debug 开关），改变可见代理数不影响 fulfillment

> Phase 1 完成后，整个 sim 就**只剩一个反馈源等待接入 = 货物链**。

---

### Phase 2 · 经济链 V0 + 货车（核心，3 天）

#### Task C1 · ResourceCatalog / ProducerCatalog（配置表）

**产出**：
```
src/sim/economy/catalog.ts      （新建）
  ├ RESOURCE_CATALOG: { id, layer: 'raw'|'intermediate'|'end', baseRate }
  ├ PRODUCER_CATALOG: { id, inputs, outputs, ratio, footprint, name }
  └ Zone → 终端货物映射表
src/sim/economy/types.ts        （新建）
  ├ ResourceId, ProducerId, NodeId, LineId
  └ ChainNode 接口
```

V0 列表（与 `design.md §4.2` 一致）：6 货物 + 4 产业（farm/forest/sawMill/foodPlant + 商业/工业终端）。

**验收**：TS 类型通过；HUD 调试面板能列出所有 ResourceId / ProducerId。

---

#### Task C2 · ChainNode 数据层

**改动点**：
- `sim/buildings.ts`：保留 BuildingStore（建筑实例渲染用）
- `sim/economy/chain.ts`（新建）：
  - `ProducerNode { id, producerId, pos, level, inBuffer, outBuffer, tickProduce() }`
  - `ChainStore`：所有产业节点的 SoA-friendly 容器
  - `level` 的 "使用即成长" 曲线（design.md §4.4）

**节点 → 建筑**关系：
- 一个 Producer 节点 = 一栋建筑（建筑用 BuildingStore 渲染，但其经济行为由 ChainStore 推进）
- 玩家"建产业"时同时 `buildingStore.spawn()` + `chainStore.spawn()`

**验收**：
- 单元测试或 console：手动 push 100 单位 grain 到 FoodPlant.inBuffer → 多 tick 后 outBuffer.food 累加
- 入料断 30 ticks 后 level downgrade

---

#### Task C3 · TransportLine + 货车 agent

**产出**：
```
src/sim/economy/lines.ts        （新建）
  ├ TransportLine { id, src, dst, vehicleType, count, edges }
  ├ LineStore：所有线集合
  └ tickLines()：扣 outBuffer → 派车 → 抵达 → 加 inBuffer + 结算 revenue

src/sim/agents.ts
  └ AgentKind 加 'truck'；CargoBuffer 字段（uint16，载货量）
src/sim/tick.ts
  └ 货车 trip 推进沿用现成 edge 走法；多一份"装载 / 卸货"phase
```

**寻路**：复用 `roadGraph.fastestPath`，成本函数对货车 = pure time（不在乎 comfort）。

**收入公式**（design.md §4.5）落地：

```ts
const aerial = Math.hypot(srcPos.x - dstPos.x, srcPos.z - dstPos.z)
const speedF = baseSpeed / Math.max(1, travelTicks / TICK_HZ)
const rev    = baseRate(res) * aerial * speedF * delivered
```

**验收**：
- 一条 Farm→FoodPlant 线跑 5 分钟内净利润 > 0
- 切断中间路 → 货车寻路失败 → outBuffer 堆积 → 短期内 FoodPlant.level 不变；30 ticks 后 downgrade

---

### Phase 3 · 城市受动（接 fulfillment 真实源，2 天）

#### Task T1 · TownDistrict 接管已有 District

**改动点**：
- `sim/districts.ts`：把当前 `stepDistricts` 里基于 `metrics.commercialCoverage / housingDemandPressure` 的 fulfillment 公式**整段删掉**，换成：
  ```
  for each district:
    供给量 = Σ 流入该街区覆盖范围的终端品 / 时间窗
    需求量 = district.area × demandPerTile[zone]
    fulfillment = clamp(min(供给/需求), 0, 1.2)
  ```
- `sim/districts.ts`：每个 district 多两个字段 `supplied: Map<ResourceId, number>` / `demand: Map<ResourceId, number>`
- `sim/economy/lines.ts`：货车抵达 TownDistrict 时，向其 `supplied[res] += delivered` 累加（带年化滚动窗口）

**zone → 需求货物映射**：
| zone | 需求货物 |
|---|---|
| residential | （不直接消费，由 commercial 间接服务） |
| commercial | food（必需）、goods（可选） |
| industrial | materials |

**验收**：
- 不连任何货运线 → 所有 commercial/industrial 街区 fulfillment 跌到 0 → 5-10 分钟内开始 shrink
- 连通后 → fulfillment 回升 → 城市恢复生长

---

#### Task T2 · 生灭规则细调

**改动点**：
- `sim/districts.ts`：阈值从迭代 3 V0 的"60 tick / 80 tick"改成更"经济周期感"的值（粗调，后续打磨）
- 选址：保留现有"街区内空位 + 随机" → 加一条**软约束**：候选位置必须邻接道路 tile（迭代 3 V0 没强制，T2 收紧）

**验收**：
- 同上脚本第 6 步：grow 节奏稳定，不一窝蜂；shrink 不"瞬间塌房"

---

### Phase 4 · 道路工具（玩家手铺路，3 天）

> 已有半成品 `render/roadTool.ts`（rev 1）只到"画线 + 视觉道路"。本 Phase 把它接到 RoadGraph + 寻路缓存。

#### Task R3 · roadTool 完善（接 sim）

**改动点**：
- `render/roadTool.ts`：保留 select / road / bulldoze 三态；提交时通过 SimHandle 发 `'add-road'` / `'remove-road'` 消息
- 增"撤销最近一段"（Z）

#### Task R4 · RoadGraph 增量更新

**产出**：
- `sim/roadGraph.ts` 加：
  ```
  addSegment(rect): edgeIds[]
  removeSegment(parentRoadId): void
  ```
- 算法 V0：每次 add/remove 直接 **rebuild 整图** + `pathing.invalidate()`（10ms 量级，可接受）
- V1（迭代 4）：增量"切边 / 合并节点"

#### Task R5 · Worker 消息扩展

- `worker.ts` 加：
  - `'add-road' { rect }`
  - `'remove-road' { parentRoadId }`
  - 收到后调 `roadGraph.addSegment / removeSegment`，rebuild RoadHeatmap region 列表（主线程也要刷新）

#### Task R6 · 主线程渲染同步

- `RoadHeatmap` 支持增量条带（或 rebuild 整张）
- `RoadTool.onPlace` 等待 sim 回 `'road-added' { ok }` 才落子（先用乐观更新，sim 拒绝时再回滚）

**验收**：
- 玩家铺路后，下一辆派出的货车路径包含新边
- 拆路后正在路上的货车要么回头要么"任务失败 → 回库"，**不允许穿墙**

---

### Phase 5 · UI / 体验打磨（2 天）

#### Task U1 · 工具栏 + 信息卡

- 工具栏：`[选择] [铺路] [拆除] [建产业▼] [建运输线]`
- 选中建筑卡：level / inBuffer / outBuffer / 接入的 line
- 选中街区卡：zone / 各 ResourceId 的 demand & supplied & fulfillment

#### Task U2 · "建产业" 流程

- 从工具栏 dropdown 选 producer 类型
- 鼠标跟随 ghost preview（与铺路同一套 raycaster 复用）
- 落子检查：不在道路上、不与既有建筑重叠、邻接道路

#### Task U3 · "建运输线" 流程

- 工具激活后：
  1. 点 src 建筑（高亮）
  2. 点 dst 建筑
  3. 弹出"选车型 + 数量"小面板
  4. 确认 → 创建 line

#### Task U4 · 一次性教学 tooltip（最小）

- 首次启动按"铺路 → 建产业 → 建运输线 → 等城市变大"4 步指引
- 用 cookie / localStorage 记录已读

---

### Phase 6 · 性能回归（1 天）

#### Task P1 · 基线

| 指标 | 目标 |
|---|---|
| RoadGraph 节点 | 500 |
| 货车 agent | 200 |
| 装饰可见代理 | 1000 |
| 主线程 fps | ≥ 50 |
| Worker tick 耗时 | ≤ 16ms |
| 道路增删后单次 rebuild | ≤ 10ms |

#### Task P2 · 内存

- 长会话 30 分钟无内存泄漏（货车 spawn/recycle、buildingDelta 队列、SnapshotPool 归还）

---

## 4. 时间盒（建议）

```
Phase 1 降级裁剪          1d
Phase 2 经济链 + 货车      3d
Phase 3 城市受动接入       2d
Phase 4 道路工具完善       3d
Phase 5 UI 打磨            2d
Phase 6 性能回归           1d
─────────────────────────────
合计  ≈ 12 工作日（含 buffer，自然时间 2.5 周）
```

并行建议：
- Phase 2 的 C1（配置表）可与 Phase 1 并行
- Phase 4 的 roadTool 视觉部分可与 Phase 2 并行；接 sim 那一步必须在 Phase 3 之后
- Phase 5 UI 必须在 Phase 2 + Phase 3 完成后

---

## 5. 风险与对策

| 风险 | 概率 | 影响 | 对策 |
|---|---|---|---|
| 裁旧反馈环时把人口逻辑搞炸 | 中 | 中 | Phase 1 单独 PR，留 debug 开关可切回旧 economy |
| 货车寻路与装饰代理寻路抢 worker 时间 | 中 | 中 | Worker 内统一队列，按 agent kind 限频；货车优先级高于装饰 |
| 道路 rebuild 整图卡帧 | 中 | 高 | V0 接受 10ms 卡顿（铺路是低频操作，可暂停 sim 再 rebuild）；V1 再做增量 |
| 城市生灭过快/过慢 | 高 | 中 | Phase 3 完成后开"调参周"，把阈值都集中到一份 JSON 让美术/策划改 |
| 配置表 + 流程 UI 联动错乱 | 中 | 中 | C1 完成后立即生成调试面板：HUD 显示所有 ResourceCatalog 实例化状态 |
| 玩家根本看不懂"为啥城市萎缩" | 高 | 高 | U1 信息卡必须把 fulfillment 拆到每种 ResourceId 显示；缺什么标红 |

---

## 6. 完成态截图（预期）

```
┌─────────────────────────────────────────────────────────────────┐
│ KanadeSim · iter 3                              CITY TIME 08:30 │
│  HUD                                                            │
│  ├ 总建筑: 142 (R 78 · C 32 · I 32)                              │
│  ├ 经济:                                                         │
│  │   林场 #2: level 2 [logs ▮▮▮▮▮] outBuf 24                    │
│  │   食品厂 #1: level 3 [grain ▮▮▮▯▯] outBuf 18                  │
│  ├ 运输:                                                         │
│  │   #L01 林场→木材厂: 2 车 · profit +4.2/月                      │
│  │   #L02 农场→食品厂: 3 车 · profit +6.0/月                      │
│  │   #L03 食品厂→新月镇: 1 车 · profit +12.0/月 ⚠ 容量不足         │
│  └ 城市:                                                         │
│      新月镇  人口 1,240  街区 12   food fulfillment 0.94  ↑      │
│      浅汀镇  人口 380   街区 4    food fulfillment 0.21  ↓      │
│                                                                  │
│  [视图]                                                          │
│   ▔▔▔▔▔▔▔ □ □ □ ▔▔▔▔▔▔ □ □ □ ▔▔▔▔▔▔                          │
│   ▔▔▔■■▔▔▔ □ □ ▔▔▔▔▔▔▔▔▔ □ □ ▔▔▔▔▔▔                          │
│      🌾(Farm)         🏭(FoodPlant)         🏘️(Town)             │
│                                                                  │
│  [工具栏]  选择 | 铺路 | 拆除 | 建产业 ▼ | 建运输线              │
└─────────────────────────────────────────────────────────────────┘
```

---

## 7. 下一迭代候选（不在本迭代范围）

- 多产业链全集（接近 TF2 的 16 货物）
- 多种载具（卡车 / 火车 / 轮船 / 飞机），各自速度 + 容量
- 站点模块化拼装（火车站可拼月台数）
- 多城市 + 大地图 + 区域级寻路
- 时代演进（科技/载具按年解锁）
- 战役 / 任务系统
- 公共交通（载客）—— 注意这条会"回归"CS 风，要慎重再评估

---

## 8. 决策记录

| 日期 | 决策 | 影响 |
|---|---|---|
| 2026-05-27 上午 | 迭代 3 V1（CS+TF 混合）落地 districts.ts、buildingDelta、roadTool 雏形 | 留作技术资产，不全部弃用 |
| 2026-05-27 下午 | **方向定 B（TF）；本计划重写为"TF 路线 V1"** | 本文档为权威；迭代 3 起所有反馈环源自货物链 |

—— 一句话总结迭代 3：

> **从"系统驱动的活城"切到"玩家驱动的物流网"**：你修路、你连链、你派车，镇子才会长。
