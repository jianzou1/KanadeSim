# KanadeSim · 设计总纲

> 这是 KanadeSim 的**项目级设计文档**，记录玩法方向、技术栈、模拟分层、性能红线，以及每个迭代的"姿态"。
> 单个迭代的开发计划另放 `spikes/three-city/docs/iteration-N-plan.md`，**本文件不写任务级粒度**。

---

## 0. 一句话定位

> **浏览器里跑的"狂热运输式"运输/物流模拟经营**：
> 玩家在一张大地图上铺路、建产业、连货运线，把工厂的货送进城市，城市靠"被送达的货"才会长大。
> 视觉走 2.5D 正交像素 + 低多边形，氛围带一点 old web / 个人终端味道（与 USER.md 调性保持一致）。

不是城市天际线（不做单一大城市 + 精细 zoning + 个体通勤），也不是 OpenTTD（不做信号塔的硬核全模拟）——
**站位是"现代化、浏览器原生的 Transport Fever 1"**。

---

## 1. 玩法方向选型（2026-05-27 决定）

### 1.1 候选过的两条路线

| 维度 | A · 城市天际线路线 | B · 狂热运输路线（**采用**） |
|---|---|---|
| 玩家身份 | 市长，单一城市 | 物流老板，多城市 + 厂区 |
| 城市数量 | 1 个，靠服务密度变大 | N 个小镇，靠链路连接 |
| "需求"含义 | 居民对服务的满意度（抽象） | 城市消费的具体货物（具体） |
| 失败信号 | 满意度跌 → 居民搬走 | 链路断 → 工厂 downgrade → 城市萎缩 |
| 玩家主操作 | zoning + 服务建筑 + 道路 | 站点 + 干线 + 车辆 |
| 时间感 | 分秒交通 | 月年链路稳态 |

### 1.2 选 B 的理由（合 4 条）

1. **差异化更稳**。CS 赛道挤、有正版 CS2，浏览器版打不过。TF/OpenTTD 赛道反而留着"现代美术 + 浏览器原生"的空位。
2. **性能曲线更友好**。浏览器最容易爆的就是个体通勤模拟；TF 的代理量级（货车百级）天然友好。
3. **§15 经济链已经想得最透**。链 + 节点 + 产能曲线 + 收入公式已经成型，做最清楚的版本最稳。
4. **与 SOUL/USER 调性一致**。"old web / 个人终端 / 可探索空间"匹配的是"一张大地图慢慢点亮链路"，不是"一座大城市密集操作"。

### 1.3 选 B 之后的"取消"清单

- ❌ 个体通勤 agent 真实模拟（每个居民走 home→work）
- ❌ 居民满意度反馈环（CS 那种）
- ❌ 时段潮汐对城市经济的影响（早晚高峰只剩**装饰性的可见车辆**）
- ❌ 多车道 / 红绿灯 / 停车
- ❌ 单城市深度 zoning（住/商/工分区由玩家落产业自然形成）
- ❌ 服务建筑系统（消防/医疗/学校/水电）

### 1.4 选 B 之后的"保留"清单

- ✅ `roadGraph.ts`：直接给货车寻路用，几乎不改
- ✅ 24h clock + tick 框架：用来做"发货节律 + 视觉昼夜"
- ✅ 像素管线 + 镜头 + InstancedMesh 建筑：完全留用
- ✅ Agent 渲染层：原通勤 agent **降级**为"装饰性可见行人/车辆"，由统计层抽样生成，不参与经济
- ✅ 街区/建筑动态生灭（迭代 3 M3 已做）：**fulfillment 来源换成真实货物供给**，反馈环不变

### 1.5 玩家心智的"一句话"

> **"我是物流老板。我修路、办厂、连线、派车。货送到了，镇子才会变大；货断了，镇子就萎缩。"**

整个游戏的所有 KPI 都应该回答这一句话。

---

## 2. 技术栈（不变）

| 层 | 选型 | 备注 |
|---|---|---|
| 语言 | TypeScript | 严格模式 |
| 构建 | Vite | spike 直接用 |
| 渲染 | three.js + 正交相机 + 像素管线 | 2.5D 像素低 poly |
| UI | 原生 HTML/CSS（spike）/ 后续可上 Svelte | UI 不接 sim 状态 |
| 模拟循环 | Web Worker + 自研 4Hz fixed tick | 已落地 |
| 数据结构 | SoA + TypedArray | §12 红线 |
| 寻路 | RoadGraph + Dijkstra（小图） | 已落地 |
| 存档 | IndexedDB（后续） | 暂未做 |
| 配置 | JSON + zod 校验 | 经济链表用 JSON |

---

## 3. 模拟分层（按 B 路线重新定义）

### 3.1 三层模型（旧分层在 §5，已被本节替换）

```
Layer 1  统计 / 货物链 / 城市需求         （主玩法层，纯数据，Worker）
  ├ 产业节点 ProducerNode（farm/sawMill/...）
  ├ 城市需求节点 TownDistrict（按 zone 接收终端品）
  ├ 运输线 TransportLine（src → dst，挂载车辆）
  └ 城市生灭：fulfillment ← Σ inBuffer / demand

Layer 2  代表性可见代理                   （视觉层，Worker → 主线程快照）
  ├ 货车 agent（实体，沿 RoadGraph 跑）
  ├ 装饰性行人/小车（数百，城市规模决定，纯统计采样，不参与经济）
  └ 24h 时钟驱动视觉昼夜

Layer 3  少量特写实体                     （后续，可观察单辆车/单条线）
  └ 玩家点击某辆车 → 看路线 / 利润 / 装载
```

### 3.2 每层的尺度

| 层 | 量级 | 浏览器友好度 |
|---|---|---|
| 货物链节点 | 几十 ~ 上百 | 完全够 |
| 货车 agent | 200 ~ 500 | 富余 |
| 装饰性行人/小车 | 500 ~ 1500 | 与迭代 2 同档 |
| 城市数量 | 5 ~ 15 | 富余 |

---

## 4. 经济链：链 + 节点（核心数据模型）

### 4.1 总图

```
ResourceCatalog（货物字典）
  ├ raw          原料（forest/farm/quarry 直接产出）
  ├ intermediate 中间品（需要原料才能产）
  └ end          终端品（卖给城市）

ProducerCatalog（产业字典）
  ├ inputs:  ResourceId[]    缺一不出货
  ├ outputs: ResourceId[]
  └ ratio:   inputs→outputs

ChainGraph
  raw → intermediate → end → TownDistrict

Node = ProducerInstance | TownDistrict
Link = TransportLine
```

### 4.2 V0 货物（迭代 3 起步）

只放 6 类，保证最小闭环跑通；架构上扩到 TF2 级 16 类是配置表加行。

| 层 | ResourceId | 来源 | 去向 |
|---|---|---|---|
| raw | `grain` | Farm | FoodPlant |
| raw | `logs` | Forest | SawMill |
| intermediate | `planks` | SawMill | Factory |
| end | `food` | FoodPlant | 城市商业区 |
| end | `goods` | Factory | 城市商业区 |
| end | `materials` | Factory | 城市工业区 |

### 4.3 节点统一接口

```ts
interface ChainNode {
  id: NodeId
  pos: Vec2
  catchment: number           // 覆盖半径
  level: 1 | 2 | 3 | 4
  inBuffer:  Map<ResourceId, number>
  outBuffer: Map<ResourceId, number>
  capacityAt(level): number
}
```

`Producer` 多一份 recipe；`TownDistrict` 多一份 demand。
**容量无上限**（学 TF2，不学 TF1），避免玩家被瞬时拥堵打死。

### 4.4 产能曲线："使用即成长"

```
连续 N 个 tick 满足：
  • 入料覆盖率 >= 0.7
  • 出货成功率 >= 0.7
→ level += 1（封顶 4）

连续 M 个 tick 任一指标 < 0.3 → level -= 1（封底 1）
连续 K 个游戏年完全闲置        → 730 天关闭倒计时
```

### 4.5 Link：运输线

```ts
interface TransportLine {
  id: LineId
  src: NodeId
  dst: NodeId
  vehicleType: VehicleId
  count: number
  // 派生
  aerialDistance: number    // 鸟瞰直线
  pathLength: number        // 沿路实际
  travelTime: number        // 含拥堵 / 坡度
}
```

收入公式（统一所有运输方式）：

```
revenuePerUnit  = baseRate(resource)
                × aerialDistance
                × speedFactor(travelTime)
maintenance/tick = pathLength × vehicleMaintenance × count
profit           = Σ delivered × revenuePerUnit - maintenance
```

含义：
- **绕路只赚直线段** → 鼓励 Z 形 + 换装站，而不是一条 S 形长线
- **越快越值钱** → 给后期换更高级载具持续动力

---

## 5. 城市：受动方，不再是主玩法

### 5.1 城市 = 一组街区 + 一份需求清单

```ts
interface Town {
  id: TownId
  name: string                // 叠词命名风格（与 QQ 农场审美一致）
  districts: TownDistrict[]   // 多个 zone 街区
  population: number          // 统计数字，不个体化
}

interface TownDistrict {
  id, zone: 'residential' | 'commercial' | 'industrial'
  bounds: Rect
  demand:   Map<ResourceId, number>   // 当前需求/年
  supplied: Map<ResourceId, number>   // 实际到货/年
  fulfillment: number                 // = clamp(min(supplied/demand), 0, 1.2)
  buildings: BuildingId[]
}
```

### 5.2 city 自生长的唯一驱动：fulfillment

```
fulfillment 来源（与迭代 1/2 的 CS 反馈无关）：
  R 街区 = Σ 实际到货的 food / 街区潜在消费量
  C 街区 = Σ 实际到货的 food + goods / 街区潜在消费量
  I 街区 = Σ 实际到货的 materials / 街区潜在消费量

grow:    连续 N tick fulfillment ≥ 0.85 + 有空位 + 邻接道路 → spawn 1 栋
shrink:  连续 N tick fulfillment ≤ 0.35 → 移除最差 1 栋
upgrade: 后续可加，先不做
```

> 这是与"路线 A · CS"的根本切割：城市不再因满意度变化，只因货物供给变化。

### 5.3 装饰性行人/小车

迭代 2 的通勤代理保留**视觉部分**：
- 按街区人口数抽样几百个可见 sprite
- 沿城市内最近道路简单游走
- **不参与经济、不计算通勤时间、不影响满足度**

目的：让玩家感觉镇子"是活的"，但模拟本质完全来自链路。

---

## 6. 玩家循环

```
        ┌─────────────────────────────────────────────┐
        │                                             │
        ▼                                             │
  铺路 → 建产业 → 建运输线 → 城市收到货 → 街区长出新建筑 → 街区需求变大 → 链路压力↑
                                                                          │
                              更多车 / 升级载具 / 拓新路 ◀──────────────────┘
```

失败循环：
```
切断链路 → 街区 fulfillment 跌 → 6 月后开始 shrink → 城市萎缩 → 全图收入跌
```

成功的核心指标（玩家关心的）：
- 各产业 utilization
- 各城市 fulfillment
- 全网每月 profit
- 车队规模 / 平均利润率

---

## 7. 性能红线

| 指标 | 目标 |
|---|---|
| 主线程 fps | ≥ 50 |
| Worker tick 耗时 | ≤ 16ms |
| 货车 agent | 200 ~ 500 |
| 装饰可见行人/车 | ≤ 1500 |
| 城市数 | 5 ~ 15 |
| 产业节点数 | ≤ 200 |
| 运输线数 | ≤ 200 |
| 道路图节点 | ≤ 1500（玩家自由铺路后） |

避坑（仍然继承自旧设计）：
- 不要每个市民一个 JS 对象
- 不要 React 状态绑定到每个 agent
- 不要每帧寻路
- 不要一开始做车道级交通

---

## 8. 路线图（高层）

| 迭代 | 主题 | 状态 |
|---|---|---|
| 迭代 1 | 程序化建筑 / C2 经济 / C3 通勤热力图 | ✅ 完成（保留视觉与道路图） |
| 迭代 2 | 真道路图 + 时间成本寻路 + 拥堵反馈 + 24h 潮汐 | ✅ 完成（经济反馈环将被裁掉） |
| **迭代 3** | **方向切换：玩家铺路 + 经济链 V0 + 城市靠货物自生长** | 🔵 进行中（详见 `iteration-3-plan.md`） |
| 迭代 4（候选） | 多产业链全集 + 多种载具 + 站点模块化 | 计划 |
| 迭代 5（候选） | 多城市 + 大地图 + 区域级寻路 | 计划 |
| 迭代 6+（候选） | 时代演进 + 公共交通 + 战役 | 计划 |

---

## 9. 与迭代 1/2 的"分手协议"

为了不浪费已落地代码，但又彻底切到 B 路线，做如下"降级 / 裁剪"：

### 9.1 保留并继续演进
- 渲染：场景、相机、像素管线、InstancedMesh 建筑、道路热力图
- 模拟：RoadGraph（pathing/edge 流量/拥堵 EMA）、24h 时钟、tick 框架、AgentStore SoA
- 工具链：Worker 通信、SnapshotPool、双缓冲

### 9.2 降级（保留 API，含义换掉）
- **通勤 agent**：依然在 AgentStore 跑，但**含义改为"装饰性可见居民"**，spawn 数量由"街区人口"决定，**不再产生满意度/通勤反馈**
- **economy.ts**：人口/就业/税收数字仍然算（给 HUD 展示），但**不反馈到 fulfillment**；commute satisfaction 项删掉
- **拥堵 EMA**：保留，仅影响货车寻路的边权和热力图渲染，不影响居民满意度

### 9.3 直接裁掉
- 通勤时间 → 满意度反馈（economy.ts COMMUTE_PENALTY 相关）
- §14 中"CS2 通勤参照"作为目标牵引（保留为历史脚注）
- "城市自生长由 CS 全市覆盖率驱动"（已存在的 `districts.ts` 第一版逻辑会被替换为"货物供给驱动"）

### 9.4 历史记录（保留只读，不再演进）

旧版 design.md（迭代 1/2 时期）的 §1 ~ §14 在 git 历史中可查。本版本起，§3 之后的"分层 / 经济链 / 城市"以**B 路线**为唯一权威。

---

## 10. 命名 / 配置约定（项目级）

- 时间统一用 `tick`（1 tick = 250ms = 4Hz）；HUD 用 `s` 显示
- 距离统一用 `tile`（1 tile ≈ 4 米感）
- 货物 / 产业 / 城市配置走 JSON，参考 QQ 农场的 `AvatarFrame.xlsx` 字段风格
- 城市名 / 产业名采用叠词命名（夏日荷风审美）
- UI 文本禁止特殊符号
- JSON 字段命名 `snake_case`，TS 字段命名 `camelCase`
- 颜色 / 配色记录在 `palette.ts`，新增颜色不要散写到组件里

---

## 11. 决策记录（ADR 简版）

| 日期 | 决定 | 影响 |
|---|---|---|
| 2026-05-26 | 主栈定 TypeScript + three.js | 后续不再讨论引擎 |
| 2026-05-27 上午 | 调研狂热运输 2 + 制定迭代 3 V1 计划（含 §15/§16） | 落地 districts.ts、buildingDelta 协议、roadTool 雏形 |
| **2026-05-27 下午** | **玩法方向定为 B 路线（TF）；裁掉 CS 反馈；§15 升级为"权威经济链"** | 本版 design.md；迭代 3 计划重写 |

---

> 维护人：Nemo（驻留精灵） · 数据来源：项目对话与 SOUL.md / USER.md / IDENTITY.md
