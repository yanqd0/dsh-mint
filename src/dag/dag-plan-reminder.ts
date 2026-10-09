/**
 * Empty-DAG reminder for plan mode.
 *
 * The `mint` skill's research discipline now starts a DAG the moment a session
 * enters plan mode (`references/plan-dag.md`), but the skill is prose: a session
 * that never calls `mint_plan_dag` leaves no trace, and the panel cannot even
 * say so — its auto-open rule is "this session has a DAG **with at least one
 * node** and the tab is not open" (`src/client/dag-open.ts` `shouldOpenDag`), so
 * an `init`-only document is invisible too.
 *
 * This listener is the host-side soft nudge for exactly that gap. It observes
 * `tools/post-execute` (so it can enrich, never veto) and skips subagent sessions
 * the way every other session-scoped notice does: the graph belongs to the
 * root session's panel.
 *
 * A later revision tightened the rule **and** the wording. "Reminded" is now recorded only
 * once the session has a DAG with ≥1 node — the state the panel exists in; a
 * still-empty graph (no document at all, or an `init` with zero nodes) keeps
 * answering every tool call, because the state it names is a state and not an
 * event. That is exactly the hole a real session fell into: it received the
 * reminder, ran `init`, added nothing, and heard nothing again — an empty DAG is
 * no more visible than a missing one. The two cases get different texts, and both
 * lead with the remediation instead of with `init`.
 *
 * Two rules keep it harmless:
 *
 * - **Never throw.** The host's `tools/post-execute` waterfall is part of every
 *   tool call, so anything unreadable here (no projection, no session id, a DAG
 *   path that cannot even be built) must degrade to `next()`.
 * - **Never block.** The answer is `accept` + appended text — the same enrich
 *   shape as the commit/todo reminders — because a missing DAG is a discipline
 *   gap, not a reason to fail a tool call.
 */
import { readDag } from './dag-store.js';
import { planModeState } from '../host/plan-mode.js';
import { isFailedResult } from '../host/reminders.js';
import { sessionIdOf } from '../shared/session-id.js';
import type {
  ContentBlockLike,
  DshContext,
  PostToolDecisionLike,
  ToolExecutionLike,
  ToolResultLike,
} from '../shared/types.js';

/** 无文档时的提醒：节点那半句在前，因为「init 完就停」才是会话真正会忘的一步。 */
export const DAG_PLAN_REMINDER =
  '[mint] 本会话在计划模式但还没有 DAG：先 mint_plan_dag({action:"init",title:"<本计划>"})，' +
  '再给本轮要答的问题 add 节点（空图时 plan-dag 面板不会打开，调研也就没有留痕）。';

/** 有文档但 0 节点：不再提 `init`，只点剩下那一步。 */
export const DAG_EMPTY_REMINDER =
  '[mint] DAG 还是空的（0 节点 = plan-dag 面板不会打开）：先把本轮要答的问题 ' +
  'mint_plan_dag({action:"add",nodes:[…]}) 落成节点，至少一个面板才会出现。';

/**
 * 记住的会话数上限；与其它会话级 map 同值（`session-ledger.ts` / `context.ts` 都是 100）。
 *
 * 有界是泄漏守卫：本模块活得比进程服务的任何会话都久。代价与别处一致——最旧的先被
 * 挤出，仍卡在同一缺口的会话可能被再提醒一次；重复一次提醒比无界 map 便宜。
 */
export const MAX_REMINDED_SESSIONS = 100;

/**
 * 各会话已被提醒过的缺口，最旧的在前：`'missing'`（无文档）或 `'empty'`（文档 0 节点）。
 *
 * 值就是两级提醒的机关：`init` 把会话从 `'missing'` 挪到 `'empty'`——那是**另一个**
 * 缺口，所以它会再收到一次「先 add 节点」，而卡在同一状态的会话只被提醒一次。有节点的
 * 图不记：提醒已无话可说。
 */
const notified = new Map<string, DagReminderState>();

type DagReminderState = 'missing' | 'empty';

/** Forget every remembered session (tests: state must not leak between cases). */
export function resetDagPlanNotified(): void {
  notified.clear();
}

function remember(sessionId: string, state: DagReminderState): void {
  notified.delete(sessionId);
  if (notified.size >= MAX_REMINDED_SESSIONS) {
    const oldest = notified.keys().next().value;
    if (oldest !== undefined) notified.delete(oldest);
  }
  notified.set(sessionId, state);
}

async function readDagState(
  sessionId: string,
  dagDir?: string
): Promise<{ exists: boolean; nodes: number }> {
  const read = dagDir === undefined ? await readDag(sessionId) : await readDag(sessionId, dagDir);
  if (read.state !== 'ok') return { exists: false, nodes: 0 };
  return { exists: true, nodes: read.doc.nodes.length };
}

/**
 * `tools/post-execute` listener: in plan mode, with no DAG — or with a DAG that
 * still has zero nodes — append the matching reminder once per gap.
 *
 * The guards run cheapest-first and every fall-through is `next()`; the whole
 * body is wrapped because a plan-mode read could throw on a host whose
 * projection registry misbehaves (see `plan-mode.ts`), and that must not surface
 * as a tool-call error.
 */
export async function dagPlanReminderListener(
  exec: ToolExecutionLike,
  result: ToolResultLike,
  next: () => Promise<PostToolDecisionLike>,
  ctx?: DshContext,
  dagDir?: string
): Promise<PostToolDecisionLike> {
  try {
    // Every guard falls through to `next()`: the host hands the waterfall an
    // `undefined` decision from a listener that declines to answer, and this
    // reminder must never be the reason a tool call behaves differently.
    // A failed call changed nothing: the same rule as the commit/todo reminders.
    if (isFailedResult(result)) return next();
    // A subagent's session is not the one the panel draws (the DAG resolves to
    // the root session); the root session's own call is where the nudge belongs.
    if ((exec.agent?.session?.header?.delegationDepth ?? 0) > 0) return next();
    const sessionId = sessionIdOf(exec.agent);
    if (sessionId === undefined) return next();
    const mode = planModeState(ctx, exec);
    if (mode === undefined || mode.active !== true) return next();
    const state = await readDagState(sessionId, dagDir);
    // A node is the panel's own existence condition (`src/client/dag-open.ts`),
    // so a graph that has one is no longer this reminder's business.
    if (state.nodes > 0) return next();
    // One nudge per gap: a session told "no DAG" stays quiet about it, and
    // the `init` that turns the gap into "empty" earns the one follow-up.
    const gap: DagReminderState = state.exists ? 'empty' : 'missing';
    if (notified.get(sessionId) === gap) return next();
    const reminder: ContentBlockLike = {
      type: 'text',
      text: state.exists ? DAG_EMPTY_REMINDER : DAG_PLAN_REMINDER,
    };
    // Recorded only on delivery: a session whose DAG read failed must stay
    // eligible for the next call.
    remember(sessionId, gap);
    return { kind: 'accept', content: [...result.content, reminder] };
  } catch {
    return next();
  }
}

export function installDagPlanReminder(ctx: DshContext, dagDir?: string): () => void {
  return ctx.on(
    'tools/post-execute',
    (exec: ToolExecutionLike, result: ToolResultLike, next: () => Promise<PostToolDecisionLike>) =>
      dagPlanReminderListener(exec, result, next, ctx, dagDir)
  );
}
