import { runMint } from '../mint/mint.js';
import { planModeState } from './plan-mode.js';
import type { DshContext, PreToolDecisionLike, ToolExecutionLike } from '../shared/types.js';

/**
 * The host's plan-mode exit tool. Both listeners that care about it (this gate
 * and the plan-mode record notice in `reminders.ts`) read the name from here, so
 * the host contract has one home.
 */
export const EXIT_PLAN_MODE = 'exit_plan_mode';

/**
 * Plan statuses that satisfy the gate (#59, #135).
 *
 * The gate's question is "did this project produce a decomposable mint record
 * before leaving plan mode?", so it accepts a plan that is **decomposed and not
 * terminal**:
 *
 * - `running` — mint derives it from an active child (planned/dev/test), so the
 *   plan is decomposed by construction (#59);
 * - `open` **with at least one attached issue** — the #128 registration shape: a
 *   freshly created plan whose children are all still `open` also derives `open`
 *   (`mint`'s `container/derive.rs`), and demanding `running` here deadlocked
 *   every new session that registered advice for another plan/milestone while
 *   leaving those issues `open` (#135).
 *
 * `partial`/`done`/`dropped` are completion states and never satisfy the gate;
 * an **empty** plan stays out too — zero attached issues is exactly the hole #59
 * closed.
 */
const DECOMPOSED_PLAN_STATUSES: ReadonlySet<string> = new Set(['running', 'open']);

/**
 * True when one `plan list --json` item is a record the gate can accept.
 *
 * Exported so the verdict has one home and a direct unit test (the listener only
 * composes it with mint's answer).
 */
export function isDecomposedPlan(item: { status?: unknown; issue_count?: unknown }): boolean {
  if (typeof item.status !== 'string' || !DECOMPOSED_PLAN_STATUSES.has(item.status)) return false;
  // A derived `running` already proves an active child exists: keep the pre-#135
  // verdict for it, byte for byte.
  if (item.status === 'running') return true;
  // `open` covers both "nothing attached yet" and "all children open"; only the
  // former must keep the gate shut. An unreadable count fails open — like every
  // other unreadable answer in this file, it must not trap plan-mode exit.
  return typeof item.issue_count !== 'number' || item.issue_count > 0;
}

/**
 * One `plan list --json` row, as far as the gate reads it (#140).
 *
 * `milestone_id` is optional: a mint that omits it drops every plan into the
 * same bucket, which is exactly the pre-#140 project-wide count.
 */
export interface PlanListItem {
  id?: unknown;
  status?: unknown;
  issue_count?: unknown;
  milestone_id?: unknown;
}

/** Milestone bucket of a plan row; rows without a numeric milestone share one. */
function milestoneBucket(item: PlanListItem): string {
  return typeof item.milestone_id === 'number' ? String(item.milestone_id) : 'none';
}

/**
 * The first cluster of two or more **running** plans sharing a milestone (#140).
 *
 * The discipline is "one plan in flight per milestone", so the offence is a
 * collision inside one bucket: plans in *different* milestones were parallelised
 * deliberately by the user (`milestone set <id> --status running --force`), and
 * the gate must not fight a sanctioned parallel version. A missing or unreadable
 * `milestone_id` buckets as `none` rather than disarming the rule — such rows
 * still collide with each other, and failing closed on an unreadable *key* would
 * trap plan-mode exit on a mint whose list output drifted.
 */
export function multiRunningCluster(items: readonly PlanListItem[]): readonly PlanListItem[] {
  const buckets = new Map<string, PlanListItem[]>();
  for (const item of items) {
    if (item.status !== 'running') continue;
    const key = milestoneBucket(item);
    const bucket = buckets.get(key);
    if (bucket === undefined) {
      buckets.set(key, [item]);
      continue;
    }
    bucket.push(item);
    if (bucket.length >= 2) return bucket;
  }
  return [];
}

/** The cluster's plan ids, for the denial message (`#?` when a row carries none). */
function clusterIds(cluster: readonly PlanListItem[]): string {
  return cluster.map((item) => (typeof item.id === 'number' ? `#${item.id}` : '#?')).join(', ');
}

/**
 * The plan read behind the gate (#93).
 *
 * `--no-page` is required: mint pages `plan list` at five rows with the newest
 * id first, so a valid record older than the newest five read as "no plan at
 * all" and trapped the session in plan mode.
 *
 * `--status running` would shrink the answer further but costs the gate's two
 * distinct messages: an empty answer must keep meaning "no plan exists"
 * ({@link DENY_REASON}) while a non-empty answer without a decomposed plan means
 * "plans exist, none decomposed" ({@link UNDECOMPOSED_DENY_REASON}). The default
 * read already hides only `done`, and the overview needs no more.
 */
const PLAN_LIST_ARGV: readonly string[] = ['plan', 'list', '--json', '--no-page'];

const DENY_REASON =
  'No mint plan for this project — create one first with the mint tool: ' +
  'mint({args:["plan","create","<title>","--milestone","<id>"]}), then attach at least one issue, before exiting plan mode.';

/**
 * Denial used when plans exist but none is decomposed (#59): every plan is empty
 * or already terminal.
 *
 * The gate asks for the **record**, not the schedule: `plan plan` is the
 * start-of-work action (#128), so the message names it as a separate step
 * instead of a prerequisite for exiting plan mode (#132).
 */
const UNDECOMPOSED_DENY_REASON =
  'The mint plans for this project have no issue attached — a plan only counts once it is decomposed: ' +
  'attach at least one with mint({args:["plan","attach","<id>","<issue>"]}); ' +
  'lock the schedule with mint({args:["plan","plan","<id>"]}) when the work starts.';

/**
 * Denial used when one milestone already carries two running plans (#140).
 *
 * The message has to be action-capable, because this gate is the only place the
 * rule is enforced (mint itself guards milestones, not plans): it names the
 * colliding plans and all three convergent moves — fold this session's work into
 * the running plan, park the other plan's `planned` issues, or detach the open
 * issue that revived an already finished plan (`running` is also derived from a
 * `{done|dropped} + open` child set, see `state-machine.md`).
 */
function multiRunningReason(cluster: readonly PlanListItem[]): string {
  return (
    `${clusterIds(cluster)} are running in the same milestone — this project works one plan at a time. ` +
    'Attach this session\'s work to the running plan, or stop the other one first: ' +
    'park its planned issues with mint({args:["issue","state","reset","<issue id>"]}) ' +
    '(a plan already in dev/test belongs to another session — hand that back to the user); ' +
    'a finished plan revived by a newly attached open issue is freed with ' +
    'mint({args:["plan","detach","<plan>","<issue>"]}).'
  );
}

/**
 * Denial used when the session is not in plan mode at all (#142).
 *
 * The host keeps `exit_plan_mode` registered while plan mode is inactive and
 * throws `exit_plan_mode is only available in plan mode` from `execute` — after
 * the gate already paid for a mint read. The host's own predicate is the
 * authority here, so an inactive session gets this actionable answer instead:
 * there is nothing to exit, and the workflow continues without plan mode.
 */
const NOT_IN_PLAN_MODE_DENY_REASON =
  'This session is not in plan mode — there is nothing to exit, and no mint plan has to be registered for it. ' +
  'Continue with the normal workflow: mint({args:["plan","plan","<plan id>"]}) at the start of work, ' +
  'then issue state start per issue. To plan first, ask the user to switch the session into plan mode.';

/**
 * `tools/pre-execute` listener: block `exit_plan_mode` while the project has no
 * decomposed mint plan ({@link isDecomposedPlan}), and while one milestone
 * already carries more than one running plan ({@link multiRunningCluster}, #140),
 * keeping the host plan mechanism bound to a mint record.
 *
 * The tool name is checked BEFORE any service access, and the mint run sits
 * inside the try — a mint outage must never break an unrelated tool call
 * (fail-open; see #16). The session's project directory comes from the tool
 * execution; the plugin spawns mint directly, outside the session sandbox (#18).
 */
export async function planBindListener(
  exec: ToolExecutionLike,
  next: () => Promise<PreToolDecisionLike>,
  entry?: string,
  ctx?: DshContext
): Promise<PreToolDecisionLike> {
  if (exec.name !== EXIT_PLAN_MODE) {
    return next();
  }
  // #142: the exit tool stays registered while plan mode is inactive. Refuse the
  // call here — with the actionable reason — instead of spawning mint for a
  // decision the host is about to reject anyway. `undefined` (no reachable
  // source, or nothing observed for this session) falls through to the mint gate,
  // i.e. the pre-#142 behaviour.
  const mode = planModeState(ctx, exec);
  if (mode !== undefined && mode.active === false) {
    return { kind: 'deny', reason: NOT_IN_PLAN_MODE_DENY_REASON };
  }
  try {
    const cwd = exec.agent?.session?.header?.cwd ?? process.cwd();
    const result =
      entry === undefined
        ? await runMint(cwd, PLAN_LIST_ARGV)
        : await runMint(cwd, PLAN_LIST_ARGV, { entry });
    if (!result.ok) {
      return next();
    }
    const plans = JSON.parse(result.text ?? '{}') as {
      items?: PlanListItem[];
    };
    const items = plans.items ?? [];
    // #140: a milestone carries at most one running plan. Prove the offence from
    // the rows the gate already sees, before any fail-open path can swallow it —
    // an unreadable `status` on some other row cannot undo a collision.
    const cluster = multiRunningCluster(items);
    if (cluster.length >= 2) {
      return { kind: 'deny', reason: multiRunningReason(cluster) };
    }
    // Unknown shape (e.g. a mint whose `plan list --json` carries no derived
    // status yet) fails open: an unreadable answer must not trap plan-mode exit.
    // Since #140 one unreadable row is enough to distrust the *count*, so this is
    // `every readable` instead of the pre-#140 `at least one readable`.
    if (items.some((plan) => typeof plan.status !== 'string')) {
      return next();
    }
    if (!items.some(isDecomposedPlan)) {
      return { kind: 'deny', reason: items.length === 0 ? DENY_REASON : UNDECOMPOSED_DENY_REASON };
    }
  } catch {
    // degrade to allow — do not let a mint failure trap plan-mode exit
  }
  return next();
}

/** Register the plan-binding check on `tools/pre-execute`. */
export function installPlanBinding(ctx: DshContext, entry?: string): () => void {
  return ctx.on(
    'tools/pre-execute',
    (exec: ToolExecutionLike, next: () => Promise<PreToolDecisionLike>) =>
      planBindListener(exec, next, entry, ctx)
  );
}
