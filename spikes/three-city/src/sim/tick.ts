/**
 * 单 tick 模拟逻辑（迭代 2 · E2 · 沿 RoadGraph edge 推进）
 *
 * 三段式 trip：
 *   WalkIn   home → entry node（直线）
 *   Cruise   按 edgeSeq 推进 tOnEdge ∈ [0, 1]，跨 edge 自动切下一个
 *   WalkOut  exit node → work（直线）
 *
 * 设计原则（沿用 C3.5）：
 *   - trip 一旦发起就走到底；只有静止态（AtHome / Working）才响应 phase 切换
 *   - 拥堵反馈进 edge 速度：v = edge.speed × (1 - α × congestion)
 */

import { AgentState, AgentKind, TICK_MS } from './types';
import { TripPhase, type AgentStore } from './agents';
import { pathing, type PathContext } from './pathing';
import type { RoadGraph } from './roadGraph';
import { Phase, getPhase, hourOfDay, tickToClock as clockTickToClock } from './clock';
import { laneOffset } from './laneOffset';

const DT = TICK_MS / 1000;
const SPEED_WALK = 1.6;
const SPEED_DRIVE = 4.5;
const ARRIVE_EPS = 0.04;
const CONGESTION_SPEED_PENALTY = 0.7;

/** 兼容旧 import：导出给外部用。 */
export const tickToClock = clockTickToClock;

/** 给一个代理派发一次 trip。 */
function dispatchTrip(
  store: AgentStore,
  i: number,
  sx: number, sz: number,
  tx: number, tz: number,
  ctx: PathContext,
  tick: number,
): void {
  const plan = pathing.planTrip(sx, sz, tx, tz, ctx, /*force=*/false);
  if (!plan) {
    // 被限流：直接退回 walk 模式（直线奔目标）
    const wb = i;
    store.edgeCount[wb] = 0;
    store.tripPhase[wb] = TripPhase.WalkOut;
    store.targetX[wb] = tx;
    store.targetZ[wb] = tz;
    store.tripStartTick[i] = tick;
    return;
  }
  store.setEdgeTrip(i, plan.edges, { x: plan.entryX, z: plan.entryZ }, { x: tx, z: tz });
  store.tripStartTick[i] = tick;
  store.lastReplanTick[i] = tick;

  // 把 WalkIn 的 target 从"node 中心"修正到"第一条 edge 上的车道/人行道入口点"
  // 这样 home → 入口点是顺滑斜线，Cruise 一开始就贴着车道，不会有"先到中线再侧移"的折角
  if (plan.edges.length > 0) {
    const isDriver = store.kind[i] === AgentKind.Driver;
    const firstEdge = ctx.graph.edges[plan.edges[0]];
    const entryNodeId = ctx.graph.nearestNode(plan.entryX, plan.entryZ).id;
    const dirAtoB = firstEdge.from === entryNodeId ? 1 : 0;
    const off = laneOffset(firstEdge, ctx.graph, dirAtoB, isDriver);
    store.targetX[i] = plan.entryX + off.dx;
    store.targetZ[i] = plan.entryZ + off.dz;
  }
}

/** Cruise 阶段每 tick 推进 tOnEdge。 */
function advanceCruise(
  store: AgentStore,
  i: number,
  graph: RoadGraph,
  isDriver: boolean,
): boolean {
  // 返回 false 表示 Cruise 结束（可切到 WalkOut）
  if (store.edgeCount[i] === 0) return false;
  let eid = store.getEdgeId(i, store.edgeIdx[i]);
  if (eid < 0) return false;
  let edge = graph.edges[eid];

  // 计算速度（拥堵衰减 + walker/driver 区分）
  const baseSpeed = isDriver ? SPEED_DRIVE : SPEED_WALK;
  const speed = isDriver
    ? baseSpeed * (1 - CONGESTION_SPEED_PENALTY * edge.congestion)
    : baseSpeed;     // walker 不受车流拥堵影响
  // 本 tick 实际能走的"世界距离"
  const distThisTick = speed * DT;

  // 推进
  let t = store.tOnEdge[i] + distThisTick / Math.max(0.001, edge.length);

  // 跨 edge：循环里要同步更新 edge / eid，否则 arriveNode、长度都会用旧值，
  // 在井字交叉口处反复横跳。
  while (t >= 1.0) {
    const overshootDist = (t - 1.0) * edge.length;     // 用"距离"做载体，长度变化天然对齐
    const nextIdx = store.edgeIdx[i] + 1;
    if (nextIdx >= store.edgeCount[i]) {
      // 走完最后一段，落到 to 端 + 车道偏移
      const aToB = store.edgeDirAtoB[i] === 1;
      const fromN = aToB ? graph.nodes[edge.from] : graph.nodes[edge.to];
      const toN = aToB ? graph.nodes[edge.to] : graph.nodes[edge.from];
      const off = laneOffset(edge, graph, store.edgeDirAtoB[i], isDriver);
      store.x[i] = toN.x + off.dx;
      store.z[i] = toN.z + off.dz;
      const dx = toN.x - fromN.x;
      const dz = toN.z - fromN.z;
      const d = Math.hypot(dx, dz) || 1;
      store.vx[i] = (dx / d) * speed;
      store.vz[i] = (dz / d) * speed;
      store.tOnEdge[i] = 1;
      return false;     // Cruise 结束
    }
    // 切到下一 edge：决定方向（共享 node 在哪一端）
    const nextEid = store.getEdgeId(i, nextIdx);
    const nextEdge = graph.edges[nextEid];
    // 当前 edge 的"到达 node" = 朝 from→to 是 edge.to，反向是 edge.from
    const arriveNode = store.edgeDirAtoB[i] === 1 ? edge.to : edge.from;
    if (nextEdge.from === arriveNode) {
      store.edgeDirAtoB[i] = 1;
    } else if (nextEdge.to === arriveNode) {
      store.edgeDirAtoB[i] = 0;
    } else {
      // 拓扑异常（不该发生）：保持原方向
      store.edgeDirAtoB[i] = 1;
    }
    store.edgeIdx[i] = nextIdx;
    // 关键：把 edge / eid 切到下一段，下次循环 / 投影才会用正确的几何
    eid = nextEid;
    edge = nextEdge;
    // overshoot 距离 → 新 edge 的 t
    t = overshootDist / Math.max(0.001, edge.length);
    if (!isFinite(t) || t < 0) t = 0;
  }
  store.tOnEdge[i] = t;

  // 投影位置：lerp(from, to) + 车道/人行道偏移（用循环结束后的 edge）
  const aToB2 = store.edgeDirAtoB[i] === 1;
  const aN = aToB2 ? graph.nodes[edge.from] : graph.nodes[edge.to];
  const bN = aToB2 ? graph.nodes[edge.to] : graph.nodes[edge.from];
  const tt = store.tOnEdge[i];
  const off = laneOffset(edge, graph, store.edgeDirAtoB[i], isDriver);
  const newX = aN.x + (bN.x - aN.x) * tt + off.dx;
  const newZ = aN.z + (bN.z - aN.z) * tt + off.dz;
  store.vx[i] = (newX - store.x[i]) / DT;
  store.vz[i] = (newZ - store.z[i]) / DT;
  store.x[i] = newX;
  store.z[i] = newZ;
  return true;
}

/** 单 tick：推进所有代理。 */
export function stepTick(
  store: AgentStore,
  tick: number,
  ctx: PathContext,
  onArriveWork?: (tripTicks: number) => void,
): void {
  pathing.beginTick();
  const phase = getPhase(tick);
  const hour = hourOfDay(tick);
  const graph = ctx.graph;
  const {
    x, z, vx, vz,
    targetX, targetZ,
    state, kind,
    homeX, homeZ, workX, workZ,
    tripPhase,
    count,
  } = store;

  for (let i = 0; i < count; i++) {
    // --- 状态切换 ---------------------------------------------------------
    // E4：个人化离家/下班时刻，避免所有人在同一秒触发 dispatchTrip 造成画面瞬移
    if (phase === Phase.Morning && state[i] === AgentState.AtHome && hour >= store.leaveHomeHour[i]) {
      state[i] = AgentState.GoingToWork;
      dispatchTrip(store, i, x[i], z[i], workX[i], workZ[i], ctx, tick);
    } else if (phase === Phase.Evening && state[i] === AgentState.Working && hour >= store.leaveWorkHour[i]) {
      state[i] = AgentState.GoingHome;
      dispatchTrip(store, i, x[i], z[i], homeX[i], homeZ[i], ctx, tick);
    }

    if (state[i] !== AgentState.GoingToWork && state[i] !== AgentState.GoingHome) continue;

    const isDriver = kind[i] === AgentKind.Driver;

    // --- 三段式推进 -------------------------------------------------------
    if (tripPhase[i] === TripPhase.WalkIn) {
      // 朝 entry（targetX/Z）走
      const dx = targetX[i] - x[i];
      const dz = targetZ[i] - z[i];
      const distSq = dx * dx + dz * dz;
      if (distSq < ARRIVE_EPS) {
        // 进入 Cruise
        if (store.edgeCount[i] > 0) {
          tripPhase[i] = TripPhase.Cruise;
          // 把当前位置 snap 到 entry 节点 + 车道偏移
          const firstEid = store.getEdgeId(i, 0);
          const firstEdge = graph.edges[firstEid];
          // 决定方向：当前位置最近 node 是 from 还是 to（用偏移前的 entry 坐标判断）
          const entryNode = graph.nearestNode(x[i], z[i]);
          if (firstEdge.from === entryNode.id) store.edgeDirAtoB[i] = 1;
          else if (firstEdge.to === entryNode.id) store.edgeDirAtoB[i] = 0;
          else store.edgeDirAtoB[i] = 1;
          store.tOnEdge[i] = 0;
          // snap 到"node 中心 + 车道偏移"，与 advanceCruise 的投影口径一致
          const off = laneOffset(firstEdge, graph, store.edgeDirAtoB[i], isDriver);
          x[i] = entryNode.x + off.dx;
          z[i] = entryNode.z + off.dz;
        } else {
          // 没有 edge → 直接 WalkOut（同一最近 node 的退化情形）
          tripPhase[i] = TripPhase.WalkOut;
          // exit 位置在 wp1（同时也是 work，已在 dispatch 时写入 targetX/Z 兜底）
          const exit = store.getWaypoint(i, 1);
          targetX[i] = exit.x;
          targetZ[i] = exit.z;
        }
        continue;
      }
      const speed = isDriver ? SPEED_DRIVE : SPEED_WALK;
      const d = Math.sqrt(distSq);
      const stepDist = speed * DT;
      // 一帧能跨过 entry：直接 snap，不冲过头
      if (stepDist >= d) {
        x[i] = targetX[i];
        z[i] = targetZ[i];
        vx[i] = 0;
        vz[i] = 0;
        continue;
      }
      vx[i] = (dx / d) * speed;
      vz[i] = (dz / d) * speed;
      x[i] += vx[i] * DT;
      z[i] += vz[i] * DT;
      continue;
    }

    if (tripPhase[i] === TripPhase.Cruise) {
      const stillCruising = advanceCruise(store, i, graph, isDriver);
      if (!stillCruising) {
        // 切 WalkOut
        tripPhase[i] = TripPhase.WalkOut;
        // exit 节点已经是当前位置；目标改为 work / home（dispatchTrip 已写入 wp1）
        const exit = store.getWaypoint(i, 1);
        targetX[i] = exit.x;
        targetZ[i] = exit.z;
      }
      continue;
    }

    // WalkOut: 朝 work / home 直线走
    {
      const dx = targetX[i] - x[i];
      const dz = targetZ[i] - z[i];
      const distSq = dx * dx + dz * dz;
      if (distSq < ARRIVE_EPS) {
        // 到达
        if (state[i] === AgentState.GoingToWork) {
          state[i] = AgentState.Working;
          // E3：上报通勤时长
          if (onArriveWork && store.tripStartTick[i] >= 0) {
            const dur = tick - store.tripStartTick[i];
            if (dur > 0) onArriveWork(dur);
          }
          store.tripStartTick[i] = -1;
        } else if (state[i] === AgentState.GoingHome) {
          state[i] = AgentState.AtHome;
          store.tripStartTick[i] = -1;
        }
        // snap 位置到目标，避免下一帧再读到偏离值
        x[i] = targetX[i];
        z[i] = targetZ[i];
        vx[i] = 0;
        vz[i] = 0;
        continue;
      }
      const speed = isDriver ? SPEED_DRIVE : SPEED_WALK;
      const d = Math.sqrt(distSq);
      const stepDist = speed * DT;
      // 关键：如果这一帧能跨过 target，直接 snap，不能"冲过头"再下一帧反弹
      if (stepDist >= d) {
        x[i] = targetX[i];
        z[i] = targetZ[i];
        vx[i] = 0;
        vz[i] = 0;
        // 不在这里切 state，让"距离 < ARRIVE_EPS" 的分支在下一帧统一处理；
        // 这样到达动画 / commute 上报都走同一条路径。
        continue;
      }
      vx[i] = (dx / d) * speed;
      vz[i] = (dz / d) * speed;
      x[i] += vx[i] * DT;
      z[i] += vz[i] * DT;
    }
  }
}
