/**
 * The session's host plan state, as this layer can observe it.
 *
 * Extracted from `planbind.ts` so the plan-mode exit gate and the empty-DAG
 * reminder read **one** answer to "is this session in plan mode?" instead of
 * two drifting copies. Behaviour is byte-for-byte the extracted gate logic.
 */
import { planModeKnownState } from './session-ledger.js';
import type { DshContext, ToolExecutionLike } from '../shared/types.js';

/** What a caller knows about the session's host plan state. */
export interface PlanModeStateLike {
  /**
   * The plan value the session log carries. A *queued* selection is irrelevant
   * here: the host's own `exit_plan_mode` refuses on the logged value only, so
   * denying whenever the logged value is `false` matches the host exactly.
   */
  active?: unknown;
}

/**
 * The slice of the host's `ctx.sessionProjections` consumed here.
 *
 * `stateOf(session, '<key>')` is how host plugins read a session projection
 * (`dsh-terminal-bash` reads `sandboxMode` the same way); the plan projection's
 * key is `plan` and its state carries `active`.
 */
interface SessionProjectionsLike {
  stateOf(session: unknown, key: string): { active?: unknown } | undefined;
}

/** The plan projection's key (`@deepseek-ai/dsh-plan-mode` `planProjectionDefinition`). */
export const PLAN_PROJECTION_KEY = 'plan';

/**
 * The session's host plan state, or `undefined` when it cannot be read.
 *
 * `ctx.planMode` — the obvious source — is **not reachable from this layer**: the
 * plan-mode plugin is mounted inside an isolated cordis group
 * (`@deepseek-ai/dsh-web-app` `presets/standard.patch.yml`: `isolate: { planMode:
 * true }`), which was verified live on 0.2.0-rc.2 (the gate fell through to the
 * mint read). The two routes here are what a root-layer plugin can actually see,
 * in order of authority:
 *
 * 1. the session projection `plan` — the very state the host's `exit_plan_mode`
 *    checks (`dsh-plan-mode` `loggedActive`), folded from the log, so it survives
 *    resume and fork;
 * 2. the session ledger's observed `plan/mode` events, which cover the common
 *    case (this session entered or left plan mode in this process) but answer
 *    `undefined` for a session restored from disk.
 *
 * Everything else — no projection registry, no `stateOf`, a throw, an unreadable
 * answer — is "no evidence": the caller falls through to the mint gate exactly as
 * before, so a host whose internals drift can never trap plan-mode exit.
 */
export function planModeState(
  ctx: DshContext | undefined,
  exec: ToolExecutionLike
): PlanModeStateLike | undefined {
  const session = exec.agent?.session;
  try {
    const projections = ctx?.get?.('sessionProjections') as SessionProjectionsLike | undefined;
    const state = projections?.stateOf?.(session, PLAN_PROJECTION_KEY);
    if (state !== undefined && state !== null) return { active: state.active };
  } catch {
    // Fall through to the ledger: an unreadable projection is not evidence.
  }
  const observed = planModeKnownState(session?.id);
  return observed === undefined ? undefined : { active: observed };
}
