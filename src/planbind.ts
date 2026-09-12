import { runMint } from './mint.js';
import type { DshContext, PreToolDecisionLike, ToolExecutionLike } from './types.js';

const EXIT_PLAN_MODE = 'exit_plan_mode';
const TERMINAL_PLAN_STATUSES = new Set(['done', 'dropped']);

const DENY_REASON =
  'No active mint plan for this project — create one first with the mint tool: ' +
  'mint({args:["plan","create","<title>","--milestone","<id>"]}), then attach the issues, before exiting plan mode.';

/**
 * `tools/pre-execute` listener: block `exit_plan_mode` while the project has no
 * active mint plan, keeping the host plan mechanism bound to a mint plan.
 *
 * The tool name is checked BEFORE any service access, and the mint run sits
 * inside the try — a mint outage must never break an unrelated tool call
 * (fail-open; see #16). The session's project directory comes from the tool
 * execution; the plugin spawns mint directly, outside the session sandbox (#18).
 */
export async function planBindListener(
  exec: ToolExecutionLike,
  next: () => Promise<PreToolDecisionLike>,
): Promise<PreToolDecisionLike> {
  if (exec.name !== EXIT_PLAN_MODE) {
    return next();
  }
  try {
    const cwd = exec.agent?.session?.header?.cwd ?? process.cwd();
    const result = await runMint(cwd, ['plan', 'list', '--json']);
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
