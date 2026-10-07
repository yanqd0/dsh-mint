/**
 * Empty-DAG reminder for plan mode (#169).
 *
 * The `mint` skill's research discipline now starts a DAG the moment a session
 * enters plan mode (`references/plan-dag.md`), but the skill is prose: a session
 * that never calls `mint_plan_dag` leaves no trace, and the panel cannot even
 * say so — its auto-open rule is "this session has a DAG **with at least one
 * node** and the tab is not open" (`src/client/dag-open.ts` `shouldOpenDag`), so
 * an `init`-only document is invisible too.
 *
 * This listener is the host-side soft nudge for exactly that gap. It observes
 * `tools/post-execute` (so it can enrich, never veto), reminds **once per
 * session**, and skips subagent sessions the way every other session-scoped
 * notice does (#113): the graph belongs to the root session's panel.
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
import { planModeState } from './plan-mode.js';
import { isFailedResult } from './reminders.js';
import { sessionIdOf } from './session-id.js';
import type {
  ContentBlockLike,
  DshContext,
  PostToolDecisionLike,
  ToolExecutionLike,
  ToolResultLike,
} from './types.js';

/**
 * The nudge text.
 *
 * It names the two steps that make the panel exist (`init`, then one node) and
 * why an empty graph is the same as no graph — the skill owns the discipline
 * (`references/plan-dag.md`); this line only delivers it at the moment the
 * session is provably in plan mode without one.
 */
export const DAG_PLAN_REMINDER =
  '[mint] 本会话在计划模式但还没有 DAG：先 mint_plan_dag({action:"init",title:"<本计划>"})，' +
  '再给本轮要答的问题 add 节点（空图时 plan-dag 面板不会打开，调研也就没有留痕）。';

/**
 * How many sessions are remembered; matches the other bounded session maps
 * (`session-ledger.ts` `MAX_SESSIONS`, `context.ts` `MAX_REGISTERED_SESSIONS`).
 *
 * Bounded because this module outlives every session the process serves. The
 * bound is the same 100, and so is the consequence: the oldest id is evicted
 * first, and a session that is *still* in plan mode without a DAG at that point
 * can be reminded a second time. That is the accepted trade in every other
 * session fact here — a repeat nudge is cheaper than an unbounded map.
 */
export const MAX_REMINDED_SESSIONS = 100;

/**
 * Sessions already reminded, oldest first.
 *
 * Only root sessions that actually received the reminder are remembered, and a
 * session that is still empty on the *next* call is deliberately not remembered
 * — "no DAG yet" is a state, not an event, so the nudge must survive a few tool
 * calls that happen before the model gets around to `init`.
 */
const notified = new Set<string>();

/** Forget every remembered session (tests: state must not leak between cases). */
export function resetDagPlanNotified(): void {
  notified.clear();
}

/** Remember one reminded session, evicting the oldest entry past the bound. */
function remember(sessionId: string): void {
  if (notified.has(sessionId)) return;
  if (notified.size >= MAX_REMINDED_SESSIONS) {
    const oldest = notified.values().next().value;
    if (oldest !== undefined) notified.delete(oldest);
  }
  notified.add(sessionId);
}

/**
 * True when the session has no usable DAG: no document at all, or one that
 * carries zero nodes.
 *
 * `readDag`'s two negative states are treated as one answer on purpose. A
 * missing file is the ordinary "not started"; `unreadable` (invalid JSON, a
 * document owned by another session) is a broken graph the panel does not show
 * either, and the reminder is the actionable message for both. This is a
 * reminder, so a false nudge costs one line — a silent gap costs the trace.
 */
async function hasEmptyDag(sessionId: string, dagDir?: string): Promise<boolean> {
  const read = dagDir === undefined ? await readDag(sessionId) : await readDag(sessionId, dagDir);
  return read.state !== 'ok' || read.doc.nodes.length === 0;
}

/**
 * `tools/post-execute` listener: in plan mode, with no DAG (or an empty one),
 * append {@link DAG_PLAN_REMINDER} once per session.
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
    if (sessionId === undefined || notified.has(sessionId)) return next();
    const mode = planModeState(ctx, exec);
    if (mode === undefined || mode.active !== true) return next();
    if (!(await hasEmptyDag(sessionId, dagDir))) return next();
    const reminder: ContentBlockLike = { type: 'text', text: DAG_PLAN_REMINDER };
    // Marked only once the reminder is actually being delivered, so a session
    // whose DAG read failed is still eligible for the next call.
    remember(sessionId);
    return { kind: 'accept', content: [...result.content, reminder] };
  } catch {
    return next();
  }
}

/**
 * Register the empty-DAG reminder on `tools/post-execute`.
 *
 * @param ctx - the plugin's root context, so every session's tool calls are seen.
 * @param dagDir - DAG directory override; absent means `DAG_DIR` (tests point it
 *   at a temporary directory, like the DAG route's own harness).
 */
export function installDagPlanReminder(ctx: DshContext, dagDir?: string): () => void {
  return ctx.on(
    'tools/post-execute',
    (exec: ToolExecutionLike, result: ToolResultLike, next: () => Promise<PostToolDecisionLike>) =>
      dagPlanReminderListener(exec, result, next, ctx, dagDir)
  );
}
