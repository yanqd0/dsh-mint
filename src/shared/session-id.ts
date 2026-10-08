import type { AgentsLike } from './types.js';

/**
 * Session identity of a host `Agent` (or of anything carrying one).
 *
 * The runtime may hand out a fresh `Agent` object per dispatch, so only the
 * session id is stable — every session-scoped decision (approval grants, the
 * mint-write ledger, the injection channel's dedup) has to key on it. Absent
 * or non-string ids yield `undefined`, which means "do not attribute": callers
 * then fail open (no grant remembered, no injection dedup applied).
 *
 * Its own module only so the three callers can share one rule instead of
 * restating the shape three times (which is what this module prevents).
 *
 * {@link rootSession} lives here too: it is the same question asked one level
 * up the chain, and **two** tools need the answer (`mint_plan_dag` and the
 * worktree tool), so keeping the walk next to `sessionIdOf` is what stops a
 * second copy of it from appearing in the next tool.
 */

export function sessionIdOf(agent: unknown): string | undefined {
  const sessionId = (agent as { session?: { id?: unknown } } | undefined)?.session?.id;
  return typeof sessionId === 'string' ? sessionId : undefined;
}

/**
 * Where a root-session walk stopped.
 *
 * 两种出口**必须可区分**：走到顶（`resolved: true`）说明这条链真的属于那个会话，
 * 而「注册表里查不到下一个会话」（`resolved: false`）只说明**走不下去了**——它可能
 * 就是根，也可能是宿主释放了中间会话之后的一段残链。把后者当成根会让工具把图写
 * 到一张不该存在的文件里（或撞上同名旧文档），所以调用方要能分辨这两件事。
 */
export interface RootSession {
  /** 可达链的最后一跳。 */
  id: string;
  /** 是否确实走到了「没有父会话」的顶层。 */
  resolved: boolean;
}

/**
 * How far {@link rootSession} walks up a delegation chain.
 *
 * A chain deeper than this is a host bug or a cycle, not a plan: the walk stops
 * and gives up instead of looping.
 */
const MAX_SESSION_HOPS = 16;

/**
 * The session id a session-scoped write belongs to.
 *
 * A subagent's own session is the wrong owner: the plan DAG describes the plan
 * the *main* agent is running, and the panel that draws it is attached to that
 * session. So the walk follows `session.header.parentSession` up to the top,
 * with a visited set and a hop ceiling because a corrupted or cyclic chain must
 * fail closed rather than loop.
 *
 * 出口两分（见 {@link RootSession}）：没有父会话 = 真根（`resolved: true`），
 * 注册表答不出下一跳 = 链到此为止（`resolved: false`）；起点读不出 id、成环、
 * 超过跳数上限一律 `undefined`（fail closed，调用方据此拒绝而不是猜归属）。
 *
 * @param agent - the tool execution's agent, however malformed.
 * @param agents - the host's live-agent registry, when the composition has one.
 * @returns the last reachable session, or `undefined` when the walk cannot start.
 */
export function rootSession(
  agent: unknown,
  agents: AgentsLike | undefined
): RootSession | undefined {
  const start = sessionIdOf(agent);
  if (start === undefined) return undefined;
  const visited = new Set<string>();
  let current = start;
  for (let hop = 0; hop < MAX_SESSION_HOPS; hop += 1) {
    if (visited.has(current)) return undefined;
    visited.add(current);
    const entry = agents?.get(current);
    // 没有注册表（lean 宿主）或这个会话已经不在册：链到此为止，**不能**当成根——
    // 中间会话被释放时这里答的就是中间那一跳。
    if (entry === undefined) return { id: current, resolved: false };
    const parent = entry.session.header.parentSession;
    if (typeof parent !== 'string' || parent.length === 0) return { id: current, resolved: true };
    current = parent;
  }
  return undefined;
}

/** 一次调用解析出的工具面归属：要么给出归属会话，要么给出拒绝理由。 */
export type OwnerResolution = { ok: true; id: string } | { ok: false; error: string };

/**
 * 工具面的归属策略：把 {@link rootSession} 的两种出口翻译成「能用 / 不能用」。
 *
 * 规则只写这一处（两个工具共用），四条：
 * ① 上溯根本没开始（起点读不出 id / 成环 / 超深）→ 拒绝；
 * ② 走到顶 → 用那个根；
 * ③ 断在**起点**（无注册表的 lean 宿主，或调用者自己就是顶层）→ 仍用起点这**一个** id：
 *    这是本改动前的口径，不收紧；
 * ④ 断在**中途** → 拒绝并点名那个查不到的会话：写中间会话的文件既不是根，也可能
 *    撞上同名旧文档，宁可让 main 收尾。
 *
 * @param agent - the tool execution's agent, however malformed.
 * @param agents - the host's live-agent registry, when the composition has one.
 */
export function resolveToolOwner(
  agent: unknown,
  agents: AgentsLike | undefined
): OwnerResolution {
  const root = rootSession(agent, agents);
  if (root === undefined) {
    return { ok: false, error: '无法确定会话：请在本会话内调用（需要 agent session id）' };
  }
  if (root.resolved) return { ok: true, id: root.id };
  if (root.id === sessionIdOf(agent)) return { ok: true, id: root.id };
  return {
    ok: false,
    error: `宿主 agents 注册表里查不到链上会话 ${root.id}，无法确定图归属（根会话）；请让 main 收尾该节点`,
  };
}
