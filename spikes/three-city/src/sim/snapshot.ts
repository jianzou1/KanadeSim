/**
 * 快照打包（Worker → Main）
 *
 * 策略：
 * - 维护一个固定大小的 Float32Array（双缓冲，避免主线程读时被改）
 * - 每次打包把 SoA 的活跃部分扁平化到 [x, z, state, kind, x, z, ...]
 * - 通过 transferable 把 buffer 所有权移交给主线程，零拷贝
 * - 下个 tick 用另一份缓冲，主线程用完会归还（或丢弃，Worker 重新分配）
 *
 * 为什么不直接拷 SoA：
 *   主线程拿 4 个独立 buffer 不如拿 1 个交错数组方便（renderer 一行 setMatrixAt 就能用）
 *   而且 transfer 4 个 buffer 要 4 次握手，开销更大
 */

import { AGENT_STRIDE, MAX_AGENTS, type SimSnapshot } from './types';
import type { AgentStore } from './agents';

const SNAPSHOT_LEN = MAX_AGENTS * AGENT_STRIDE;

/**
 * 双缓冲：Worker 持有 buffer A，发出去后立刻准备 buffer B 给下个 tick
 * 主线程用完会随快照消息再发回来，循环复用
 */
export class SnapshotPool {
  private freeBuffers: ArrayBuffer[] = [];

  acquire(): ArrayBuffer {
    return this.freeBuffers.pop() ?? new ArrayBuffer(SNAPSHOT_LEN * 4);
  }

  /** 主线程用完一个 buffer 后调用，归还到池。 */
  release(buf: ArrayBuffer): void {
    if (buf.byteLength === SNAPSHOT_LEN * 4 && this.freeBuffers.length < 4) {
      this.freeBuffers.push(buf);
    }
  }
}

/** 把 store 当前状态打包到一个新 buffer，返回快照对象（buffer 可 transfer）。 */
export function packSnapshot(
  store: AgentStore,
  tick: number,
  simTimeMs: number,
  buf: ArrayBuffer,
): SimSnapshot {
  const view = new Float32Array(buf);
  const { x, z, state, kind, count } = store;

  for (let i = 0, o = 0; i < count; i++, o += AGENT_STRIDE) {
    view[o] = x[i];
    view[o + 1] = z[i];
    view[o + 2] = state[i];
    view[o + 3] = kind[i];
  }

  return {
    activeAgents: count,
    agents: view,
    tick,
    simTimeMs,
    city: null,  // 由 worker 在外层填充
    roads: null, // 由 worker 在外层填充
    respawned: false, // 由 worker 在外层覆盖
  };
}
