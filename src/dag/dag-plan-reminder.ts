/**
 * Empty-DAG reminder for plan mode (#169, tightened by #171).
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
 * the way every other session-scoped notice does (#113): the graph belongs to the
 * root session's panel.
 *
 * #171 tightened the rule **and** the wording. "Reminded" is now recorded only
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

/**
 * The nudge for a session with **no DAG document at all** (#169).
 *
 * It names the two steps that make the panel exist (`init`, then one node) and
 * why an empty graph is the same as no graph — the skill owns the discipline
 * (`references/plan-dag.md`); this line only delivers it at the moment the
 * session is provably in plan mode without one. The node half leads, because
 * that is the half sessions actually forget (#171).
 */
export const DAG_PLAN_REMINDER =
  '[mint] 本会话在计划模式但还没有 DAG：先 mint_plan_dag({action:"init",title:"<本计划>"})，' +
  '再给本轮要答的问题 add 节点（空图时 plan-dag 面板不会打开，调研也就没有留痕）。';

/**
 * The nudge for a session whose DAG exists but still has **zero nodes** (#171).
 *
 * `init` alone leaves no trace the panel can draw (see {@link DAG_PLAN_REMINDER}),
 * so this text does not suggest it again — it names the one step that is left.
 */
export const DAG_EMPTY_REMINDER =
  '[mint] DAG 还是空的（0 节点 = plan-dag 面板不会打开）：先把本轮要答的问题 ' +
  'mint_plan_dag({action:"add",nodes:[…]}) 落成节点，至少一个面板才会出现。';

/**
 * How many sessions are remembered; matches the other bounded session maps
 * (`session-ledger.ts` `MAX_SESSIONS`, `context.ts` `MAX_REGISTERED_SESSIONS`).
 *
 * Bounded because this module outlives every session the process serves. The
 * bound is the same 100, and so is the consequence: the oldest id is evicted
 * first, and a session that is *still* in plan mode with the same gap can be
 * reminded a second time. That is the accepted trade in every other session
 * fact here — a repeat nudge is cheaper than an unbounded map.
 */
export const MAX_REMINDED_SESSIONS = 100;

/**
 * The reminder state each session was last nudged about, oldest session first.
 *
 * Keyed by session, one entry per session, holding which of the two gaps that
 * session has already been told about: `'missing'` (no DAG document) or
 * `'empty'` (a document with zero nodes). The value is what makes #171 work:
 * `init` moves a session from `'missing'` to `'empty'`, which is a *different*
 * gap, so that session gets the second nudge ("add a node first") exactly once
 * while a session stuck in one state stays quiet after its single reminder. A
 * graph with a node is never recorded — the reminder has nothing left to say.
 */
const notified = new Map<string, DagReminderState>();

/** The gaps this reminder knows how to name (#171). */
type DagReminderState = 'missing' | 'empty';

/** Forget every remembered session (tests: state must not leak between cases). */
export function resetDagPlanNotified(): void {
  notified.clear();
}

/**
 * Remember the gap one session was just reminded about, evicting the oldest past
 * the bound.
 *
 * The map is a bound first and a memory second: one entry per session keeps the
 * process from growing with every session it serves, whatever the model did with
 * the reminder.
 */
function remember(sessionId: string, state: DagReminderState): void {
  notified.delete(sessionId);
  if (notified.size >= MAX_REMINDED_SESSIONS) {
    const oldest = notified.keys().next().value;
    if (oldest !== undefined) notified.delete(oldest);
  }
  notified.set(sessionId, state);
}

/**
 * One session's DAG, as the reminder needs it: does a document exist, and does
 * it have a node the panel could draw?
 */
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
 * still has zero nodes — append the matching reminder once per gap (#169, #171).
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
    // One nudge per gap (#171): a session told "no DAG" stays quiet about it, and
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
