import { BASH_TOOL_NAMES } from './approval-gate.js';
import {
  CROSS_PROJECT_REASON_PREFIX,
  buildApprovalText,
  isWriteInvocation,
  listProjects,
  missingProjectMessage,
  parseBashMintCalls,
  parseInvocation,
  projectFromReason,
  projectProbeFailureMessage,
} from './cross-project.js';
import type { Invocation } from './cross-project.js';
import { TOOL_NAME } from './mint-tool.js';
import { isOwnProject } from './own-project.js';
import { sessionIdOf } from '../shared/session-id.js';

export { sessionIdOf };
import type {
  ApprovalOutcomeLike,
  ApprovalRequestLike,
  DshContext,
  PreToolDecisionLike,
  ToolExecutionLike,
} from '../shared/types.js';

/**
 * The cross-project write gate.
 *
 * Reads of another project's ledger are ordinary work, so they pass. A **write**
 * to another project moves someone else's state machine, so the first one per
 * session and target project asks the user — with the target project and the
 * action spelled out — and later writes to that same project in that same
 * session go through. The ask is the host's native `tools/pre-execute` decision
 * (`kind: 'ask'`), so a session without an approval channel (a subagent, whose
 * policy is pinned to `never`) fails closed: cross-project reads work, writes do
 * not.
 *
 * Relationship to `approval-gate.ts` — deliberately **two gates, not one**:
 *
 * 1. Different semantics: that one governs the *sandbox write permission* a bash
 *    command needs; this one governs *whose ledger* gets written.
 * 2. Reusing its once-per-session grant would make every later cross-project
 *    write unconfirmed, which is exactly what this gate forbids.
 * 3. Disjoint channels: it only inspects bash sandbox escalations, while the
 *    `mint` tool never escalates.
 *
 * Neither bypasses the other: a bash `mint -p <other> …` write is classified by
 * the same code and asks for itself, regardless of any sandbox grant; the grant
 * memory here is fed only by approvals whose reason this module built, so
 * `autoApprove` (the sandbox knob) cannot silence it.
 */

/** Bound on remembered grants, matching the approval gate's bounded map. */
const MAX_GRANTS = 100;

/** Session ids and project names never contain NUL, so it separates the key. */
const KEY_SEPARATOR = '\u0000';

/**
 * Session identity of a tool execution or approval request. The runtime may hand
 * out a fresh `Agent` object per dispatch, so only the session id is stable —
 * without one, no grant is remembered and the next write asks again.
 *
 * Re-exported from `session-id.ts`: the rule is shared with the injection
 * channel's dedup and the mint-write ledger, so it lives in one place.
 */

/** Every mint invocation a tool execution carries, from the channels we read. */
export function invocationsOf(exec: ToolExecutionLike): readonly Invocation[] {
  const args = exec?.arguments;
  if (exec?.name === TOOL_NAME) {
    const argv = args?.args;
    if (!Array.isArray(argv)) return [];
    const tokens = argv.filter((token): token is string => typeof token === 'string');
    return tokens.length === argv.length ? [parseInvocation(tokens)] : [];
  }
  if (BASH_TOOL_NAMES.has(exec?.name ?? '')) {
    return parseBashMintCalls(args?.command);
  }
  return [];
}

/** Verify the target exists, then allow, ask or deny one invocation. */
async function decide(
  exec: ToolExecutionLike,
  invocation: Invocation,
  entry: string | undefined,
  granted: ReadonlySet<string>
): Promise<PreToolDecisionLike | undefined> {
  const project = invocation.project;
  if (project === undefined) return undefined;
  const cwd = exec?.agent?.session?.header?.cwd ?? process.cwd();
  const candidates = await listProjects(cwd, entry);
  if (candidates === undefined) {
    return { kind: 'deny', reason: projectProbeFailureMessage(project) };
  }
  if (!candidates.includes(project)) {
    return { kind: 'deny', reason: missingProjectMessage(project, candidates) };
  }
  if (!isWriteInvocation(invocation)) return undefined;
  // `-p <本项目>` is the session's own ledger under an explicit name: it writes
  // exactly where the default path writes, so it is not a cross-project write
  // and must not ask. An unknown own name keeps the ask — the caller
  // fails closed. The `mint` tool separately answers with a correction hint.
  if (isOwnProject(cwd, entry, project)) return undefined;
  const sessionId = sessionIdOf(exec?.agent);
  if (sessionId !== undefined && granted.has(`${sessionId}${KEY_SEPARATOR}${project}`)) {
    return undefined;
  }
  const { reason, displayReason } = buildApprovalText(project, invocation.rest);
  return { kind: 'ask', reason, displayReason };
}

/**
 * Register the gate: `tools/pre-execute` decides, `approval/request` records the
 * once-per-(session, project) grant.
 *
 * The tool name is checked before any service or process is touched, and only a
 * *recognised* cross-project call can be denied for an internal failure — a
 * failure to judge one is refused rather than waved through, while every other
 * tool call still delegates untouched.
 */
export function installCrossProjectGate(ctx: DshContext, entry?: string): () => void {
  const granted = new Set<string>();

  const offPre = ctx.on(
    'tools/pre-execute',
    async (
      exec: ToolExecutionLike,
      next: () => Promise<PreToolDecisionLike>
    ): Promise<PreToolDecisionLike> => {
      let invocations: readonly Invocation[];
      try {
        invocations = invocationsOf(exec);
      } catch {
        invocations = [];
      }
      for (const invocation of invocations) {
        const project = invocation.project;
        if (project === undefined) continue;
        try {
          const decision = await decide(exec, invocation, entry, granted);
          if (decision !== undefined) return decision;
        } catch {
          return { kind: 'deny', reason: projectProbeFailureMessage(project) };
        }
      }
      return next();
    }
  );

  const offApproval = ctx.on(
    'approval/request',
    async (
      req: ApprovalRequestLike,
      next: () => Promise<ApprovalOutcomeLike>
    ): Promise<ApprovalOutcomeLike> => {
      const reason = req?.reason;
      if (typeof reason !== 'string' || !reason.startsWith(CROSS_PROJECT_REASON_PREFIX)) {
        return next();
      }
      const outcome = await next();
      try {
        if (outcome === 'allowed-once') {
          const project = projectFromReason(reason);
          const sessionId = sessionIdOf(req.agent);
          if (project !== undefined && sessionId !== undefined) {
            if (granted.size >= MAX_GRANTS) {
              const oldest = granted.values().next().value;
              if (oldest !== undefined) granted.delete(oldest);
            }
            granted.add(`${sessionId}${KEY_SEPARATOR}${project}`);
          }
        }
      } catch {
        // The decision stands; a missed grant only means asking again.
      }
      return outcome;
    },
    { prepend: true }
  );

  return () => {
    offPre();
    offApproval();
  };
}
