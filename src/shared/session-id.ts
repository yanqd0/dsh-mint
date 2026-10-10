import type { AgentsLike } from './types.js';

/**
 * 宿主 `Agent`（或任何带着它的东西）的会话身份：运行时可能每次派发都给一个新 `Agent`
 * 对象，只有 session id 稳定，故一切会话级决策（审批授权、mint 写台账、注入去重）都以
 * 它为键；id 缺失或非字符串即 `undefined`，意为「不作归属」，调用方据此 fail open
 * （不记授权、不做注入去重）。
 *
 * {@link rootSession} 也放这里：它是同一条链往上问一层，且 `mint_plan_dag` 与 worktree
 * 工具都要答案——紧挨 `sessionIdOf` 才不会再长出第二份拷贝。
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
  id: string;
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
 * 会话级写入该归属的会话：子代理自己的会话不是主人——plan DAG 描述的是 *main* agent 的
 * plan，画它的面板也挂在那条会话上——故沿 `session.header.parentSession` 上溯，带 visited
 * 集合与跳数上限：链损坏或成环必须 fail closed，不能打转。
 *
 * 出口两分（见 {@link RootSession}）：没有父会话 = 真根（`resolved: true`），注册表答不出
 * 下一跳 = 链到此为止（`resolved: false`）；起点读不出 id、成环、超上限一律 `undefined`。
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

export type OwnerResolution = { ok: true; id: string } | { ok: false; error: string };

/**
 * 工具面的归属策略：把 {@link rootSession} 的两种出口翻译成「能用 / 不能用」，规则只写
 * 这一处（两个工具共用）：
 * ① 上溯根本没开始（起点读不出 id / 成环 / 超深）→ 拒绝；
 * ② 走到顶 → 用那个根；
 * ③ 断在**起点**（无注册表的 lean 宿主，或调用者自己就是顶层）→ 仍用起点这**一个** id：
 *    这是本改动前的口径，不收紧；
 * ④ 断在**中途** → 拒绝并点名那个查不到的会话：写中间会话的文件既不是根，也可能撞上
 *    同名旧文档，宁可让 main 收尾。
 */
export function resolveToolOwner(agent: unknown, agents: AgentsLike | undefined): OwnerResolution {
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
