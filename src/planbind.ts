import { runMint } from './mint.js';
import type { DshContext, PreToolDecisionLike, ToolExecutionLike } from './types.js';

const EXIT_PLAN_MODE = 'exit_plan_mode';

/**
 * The only plan status that satisfies the gate (#59).
 *
 * mint derives container status from the child set: `running` means at least one
 * active issue, while `open` covers an empty or all-open plan and `partial` is a
 * **completion** state (done + dropped mix, see the mint skill's state machine).
 * Requiring `running` is therefore the same as requiring "decomposed and still
 * active", and it closes the hole where a freshly created, issue-less plan let
 * `exit_plan_mode` through.
 */
const ACTIVE_PLAN_STATUS = 'running';

const DENY_REASON =
  'No active mint plan for this project — create one first with the mint tool: ' +
  'mint({args:["plan","create","<title>","--milestone","<id>"]}), then attach the issues, before exiting plan mode.';

/**
 * Denial used when plans exist but none is `running` — the #59 case: the plan was
 * created and never decomposed (or every child already reached a terminal state).
 * Naming the missing step beats repeating the "create a plan" advice.
 */
const UNDECOMPOSED_DENY_REASON =
  'The mint plan for this project has no active issue — a plan only counts once it is decomposed: ' +
  'attach the issues and lock the schedule with mint({args:["plan","plan","<id>"]}) before exiting plan mode.';

/**
 * `tools/pre-execute` listener: block `exit_plan_mode` while the project has no
 * mint plan in {@link ACTIVE_PLAN_STATUS} (`running`, i.e. decomposed with at
 * least one active issue), keeping the host plan mechanism bound to a mint plan.
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
        ? await runMint(cwd, ['plan', 'list', '--json'])
        : await runMint(cwd, ['plan', 'list', '--json'], { entry });
    if (!result.ok) {
      return next();
    }
    const plans = JSON.parse(result.text ?? '{}') as { items?: Array<{ status?: string }> };
    const items = plans.items ?? [];
    // Unknown shape (e.g. a mint whose `plan list --json` carries no derived
    // status yet) fails open: an unreadable answer must not trap plan-mode exit.
    if (items.length > 0 && !items.some((plan) => typeof plan.status === 'string')) {
      return next();
    }
    const active = items.some((plan) => plan.status === ACTIVE_PLAN_STATUS);
    if (!active) {
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
