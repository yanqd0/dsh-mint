import { runMint } from './mint.js';
import type { DshContext, PreToolDecisionLike, ToolExecutionLike } from './types.js';

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
 * `tools/pre-execute` listener: block `exit_plan_mode` while the project has no
 * decomposed mint plan ({@link isDecomposedPlan}), keeping the host plan
 * mechanism bound to a mint record.
 *
 * The tool name is checked BEFORE any service access, and the mint run sits
 * inside the try — a mint outage must never break an unrelated tool call
 * (fail-open; see #16). The session's project directory comes from the tool
 * execution; the plugin spawns mint directly, outside the session sandbox (#18).
 */
export async function planBindListener(
  exec: ToolExecutionLike,
  next: () => Promise<PreToolDecisionLike>,
  entry?: string
): Promise<PreToolDecisionLike> {
  if (exec.name !== EXIT_PLAN_MODE) {
    return next();
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
      items?: Array<{ status?: unknown; issue_count?: unknown }>;
    };
    const items = plans.items ?? [];
    // Unknown shape (e.g. a mint whose `plan list --json` carries no derived
    // status yet) fails open: an unreadable answer must not trap plan-mode exit.
    if (items.length > 0 && !items.some((plan) => typeof plan.status === 'string')) {
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
      planBindListener(exec, next, entry)
  );
}
