/**
 * 经济链 V0 · 节点 + 产能曲线（迭代 3 · Phase 2 · C2）
 *
 * 设计来源：design.md §4.3 / §4.4
 *
 * 职责：
 *   - ProducerNode 是一栋"产业建筑"的经济模型（与 BuildingStore 的渲染态一对一）
 *   - 持有 inBuffer / outBuffer / level
 *   - 每 tick：吃 input → 生产 → 攒 output；按"使用即成长"曲线升降级
 *
 * 与 BuildingStore 的关系：
 *   - 建筑 idx ↔ ProducerNode 通过 buildingIdx 字段双向找
 *   - 一栋产业建筑销毁时，对应 ProducerNode 也要 destroy
 *
 * 与运输线的关系（下一 Task）：
 *   - TransportLine 在 tick 中："从 src.outBuffer 取" + "放进 dst.inBuffer"
 *   - 本文件不引用 LineStore，零循环依赖
 */

import {
  type ResourceId, type ProducerId, type NodeId,
} from './types';
import { getProducer } from './catalog';

// === ProducerNode ===========================================================

export interface ProducerNode {
  id: NodeId;
  producerId: ProducerId;
  /** 关联建筑 idx（BuildingStore） */
  buildingIdx: number;
  /** 节点中心点（tile 坐标），与 BuildingStore 对应建筑中心一致 */
  x: number;
  z: number;

  // 产能曲线
  level: 1 | 2 | 3 | 4;
  /** 计数器：连续达标 tick 数 */
  goodTicks: number;
  /** 连续不达标 tick 数 */
  badTicks: number;
  /** 闲置 tick（无 input 也无 output 流动）数 */
  idleTicks: number;

  // 缓冲（无上限，对齐 TF2）
  inBuffer:  Map<ResourceId, number>;
  outBuffer: Map<ResourceId, number>;

  // 统计窗口（最近 N tick 累计 ratio 判定用）
  windowProduced: number;        // 本生命周期总产出
  windowShipped:  number;        // 本生命周期总出货（被 TransportLine 抽走的量）
  /** 上次执行了一次完整生产的 tick */
  lastProduceTick: number;
}

// === 反馈环参数 =============================================================

/** 升级 / 降级 / 关闭参数（design.md §4.4）。 */
export const LEVEL_PARAMS = {
  /** 连续 N tick 满足后升级 */
  upgradeThresholdTicks: 240,   // 60s @ 4Hz
  /** 连续 N tick 不达标后降级 */
  downgradeThresholdTicks: 320, // 80s
  /** 闲置多少 tick 进入关闭倒计时（V0：简化只做"自动降级到 1"，不真销毁） */
  idleClosureTicks: 4 * 60 * 60 * 24, // 一个游戏日（240 tick * 360 = 简化 24h，先粗调）
  /** 升级判定阈值：入料覆盖率 + 出货成功率 */
  upgradeFulfillment: 0.7,
  /** 降级判定阈值 */
  downgradeFulfillment: 0.3,
  /** 每 level 的产能倍数 */
  capacityByLevel: [0, 1, 1.6, 2.4, 3.4] as const,    // [_, L1, L2, L3, L4]
};

// === ChainStore =============================================================

export class ChainStore {
  readonly nodes: ProducerNode[] = [];
  /** buildingIdx → nodeId 反查；-1 = 该建筑不是 producer */
  private byBuilding = new Int32Array(2048).fill(-1);
  private nextId = 0;

  reset(): void {
    this.nodes.length = 0;
    this.byBuilding.fill(-1);
    this.nextId = 0;
  }

  /**
   * 注册一个 producer 节点（玩家建产业时调用）。
   * @returns 新节点 id；如果建筑已经绑过 producer，返回旧 id。
   */
  spawn(producerId: ProducerId, buildingIdx: number, x: number, z: number): NodeId {
    if (buildingIdx >= 0 && this.byBuilding[buildingIdx] >= 0) {
      return this.byBuilding[buildingIdx] as NodeId;
    }
    const id = this.nextId++ as NodeId;
    const node: ProducerNode = {
      id,
      producerId,
      buildingIdx,
      x, z,
      level: 1,
      goodTicks: 0,
      badTicks: 0,
      idleTicks: 0,
      inBuffer: new Map(),
      outBuffer: new Map(),
      windowProduced: 0,
      windowShipped: 0,
      lastProduceTick: 0,
    };
    this.nodes.push(node);
    if (buildingIdx >= 0 && buildingIdx < this.byBuilding.length) {
      this.byBuilding[buildingIdx] = id;
    }
    return id;
  }

  /** 建筑销毁时清掉对应 producer。返回是否真的删了。 */
  destroyByBuilding(buildingIdx: number): boolean {
    const nid = this.byBuilding[buildingIdx];
    if (nid < 0) return false;
    const i = this.nodes.findIndex((n) => n.id === nid);
    if (i >= 0) this.nodes.splice(i, 1);
    this.byBuilding[buildingIdx] = -1;
    return true;
  }

  getByBuilding(buildingIdx: number): ProducerNode | null {
    const nid = this.byBuilding[buildingIdx];
    if (nid < 0) return null;
    return this.nodes.find((n) => n.id === nid) ?? null;
  }

  /** TransportLine 在 src 取货时调用。返回实际抽走的数量。 */
  takeFromOut(node: ProducerNode, res: ResourceId, want: number): number {
    const have = node.outBuffer.get(res) ?? 0;
    const taken = Math.min(have, want);
    if (taken > 0) {
      node.outBuffer.set(res, have - taken);
      node.windowShipped += taken;
    }
    return taken;
  }

  /** TransportLine 在 dst 卸货时调用。 */
  putToIn(node: ProducerNode, res: ResourceId, qty: number): void {
    const have = node.inBuffer.get(res) ?? 0;
    node.inBuffer.set(res, have + qty);
  }
}

// === 每 tick 主循环 =========================================================

/**
 * 推进一 tick 所有 producer。返回本 tick 总产出（HUD 用）。
 *
 * 算法：
 *   1) 对每个 node，尝试按 recipe 跑 `producePerTick × level` 次
 *      - 有 input：消耗 inBuffer；产出加到 outBuffer
 *      - 无 input（farm/forest）：直接产出
 *   2) 计数 idle / good / bad：
 *      - 本 tick 既消耗了 input，也产出了 output → goodTicks++
 *      - 本 tick 无任何 input 流入（且需要 input），或 output 长期没被取走 → badTicks++
 *      - 本 tick 完全无产出 + 无消耗 → idleTicks++
 *   3) 阈值触发升降级
 */
export function stepChain(store: ChainStore, tick: number): void {
  for (const node of store.nodes) {
    const def = getProducer(node.producerId);
    const recipe = def.recipe;

    const capacityMul = LEVEL_PARAMS.capacityByLevel[node.level];
    let triesLeft = recipe.producePerTick * capacityMul;
    // tick 内分多次尝试（用浮点累计）
    let consumedAny = false;
    let producedAny = false;

    while (triesLeft >= 1) {
      // 检查输入是否够
      let ok = true;
      for (const inp of recipe.inputs) {
        if ((node.inBuffer.get(inp.resource) ?? 0) < inp.qty) { ok = false; break; }
      }
      if (!ok) break;
      // 扣输入
      for (const inp of recipe.inputs) {
        const have = node.inBuffer.get(inp.resource) ?? 0;
        node.inBuffer.set(inp.resource, have - inp.qty);
        consumedAny = true;
      }
      // 加输出
      for (const out of recipe.outputs) {
        const have = node.outBuffer.get(out.resource) ?? 0;
        node.outBuffer.set(out.resource, have + out.qty);
        producedAny = true;
        node.windowProduced += out.qty;
      }
      triesLeft -= 1;
      node.lastProduceTick = tick;
    }

    // === 反馈环计数 =====================================================
    const needsInput = recipe.inputs.length > 0;

    // outBuffer 总量过大说明出货不畅
    let outTotal = 0;
    for (const v of node.outBuffer.values()) outTotal += v;
    const outOverflow = outTotal > 20 * capacityMul;     // 简单阈值

    // 入料是否被卡住（需要但 inBuffer 几乎为零）
    let inStarved = false;
    if (needsInput) {
      let inTotal = 0;
      for (const inp of recipe.inputs) {
        inTotal += node.inBuffer.get(inp.resource) ?? 0;
      }
      inStarved = inTotal < 0.5;
    }

    if (producedAny && !outOverflow && !inStarved) {
      node.goodTicks++;
      node.badTicks = Math.max(0, node.badTicks - 1);
      node.idleTicks = 0;
    } else if (inStarved || outOverflow) {
      node.badTicks++;
      node.goodTicks = Math.max(0, node.goodTicks - 1);
    } else if (!producedAny && !consumedAny) {
      node.idleTicks++;
    }

    // === 升降级 =========================================================
    if (node.goodTicks >= LEVEL_PARAMS.upgradeThresholdTicks && node.level < 4) {
      node.level = (node.level + 1) as 1 | 2 | 3 | 4;
      node.goodTicks = 0;
      node.badTicks = 0;
    } else if (node.badTicks >= LEVEL_PARAMS.downgradeThresholdTicks && node.level > 1) {
      node.level = (node.level - 1) as 1 | 2 | 3 | 4;
      node.badTicks = 0;
      node.goodTicks = 0;
    }
    // 闲置太久强制降到 1（V0 不真销毁，只是冷却）
    if (node.idleTicks >= LEVEL_PARAMS.idleClosureTicks && node.level > 1) {
      node.level = 1;
      node.idleTicks = 0;
    }
  }
}
