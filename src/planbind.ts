import { runMint } from './mint.js';
import type { DshContext, PreToolDecisionLike, ToolExecutionLike } from './types.js';

const EXIT_PLAN_MODE = 'exit_plan_mode';
const TERMINAL_PLAN_STATUSES = new Set(['done', 'dropped']);

const DENY_REASON =
  'No active mint plan for this project — create one first ' +
  '(`mint plan create "<title>" --milestone <id>`) and attach issues before exiting plan mode.';

/**
 * `tools/pre-execute` listener: block `exit_plan_mode` while the project has no
 * active mint plan, keeping the host plan mechanism bound to a mint plan.
 *
 * On any mint failure, JSON error, or missing shell this falls through to
 * `next()` (allow) so a mint outage never traps plan-mode exit.
 */
export async function planBindListener(
  exec: ToolExecutionLike,
  next: () => Promise<PreToolDecisionLike>,
): Promise<PreToolDecisionLike> {
  const shell = exec.agent?.ctx?.shell;
  if (exec.name !== EXIT_PLAN_MODE || !shell) {
    return next();
  }
  try {
    const result = await runMint(shell, ['plan', 'list', '--json']);
    if (!result.ok) {
      return next();
    }
    const plans = JSON.parse(result.text ?? '{}') as { items?: Array<{ status?: string }> };
    const active = (plans.items ?? []).some(
      (plan) => !TERMINAL_PLAN_STATUSES.has(plan.status ?? ''),
    );
    if (!active) {
      return { kind: 'deny', reason: DENY_REASON };
    }
  } catch {
    // degrade to allow — do not let a mint failure trap plan-mode exit
  }
  return next();
}

/** Register the plan-binding check on `tools/pre-execute`. */
export function installPlanBinding(ctx: DshContext): () => void {
  return ctx.on('tools/pre-execute', planBindListener);
}
