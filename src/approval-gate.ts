import type {
  ApprovalOutcomeLike,
  ApprovalRequestLike,
  DshContext,
  PostToolDecisionLike,
  PreToolDecisionLike,
  ToolExecutionLike,
  ToolResultLike,
} from './types.js';

const BASH_TOOL_NAMES = new Set(['bash', 'tool:bash']);
const ESCALATION_PREFIX = 'escalate sandbox to danger-full-access: ';
const MAX_PENDING = 100;
/** One argv token of a bare mint invocation: no shell metacharacters. */
const MINT_ARG = /^[A-Za-z0-9_./:=+-]+$/;
/** Standardised model justification for a mint run (context injection). */
const MINT_JUSTIFICATION = /^mint\b/;

/**
 * True when `command` is a bare `mint ...` invocation a host-trusted pass can
 * safely recognize: optional leading whitespace, the literal `mint` word, then
 * only plain argv tokens. Anything shell-shaped (`;`, `&&`, quotes, env
 * prefixes, redirections) is NOT recognized — such calls keep the ordinary
 * sandbox-denial and approval path.
 */
export function isMintCommand(command: string): boolean {
  const cmd = command.trimStart();
  if (!cmd.startsWith('mint')) return false;
  const rest = cmd.slice('mint'.length);
  if (rest !== '' && !/^[ \t]/.test(rest)) return false;
  const args = rest.trim();
  if (args === '') return true;
  return args.split(/[ \t]+/).every((token) => token.length > 0 && MINT_ARG.test(token));
}

/** True when an approval ask is a bash sandbox escalation to the widest mode. */
export function isMintEscalation(reason: string | undefined): boolean {
  return typeof reason === 'string' && reason.startsWith(ESCALATION_PREFIX);
}

/**
 * A stable identity for one agent's grant memory. The runtime may hand the
 * gate a *different* Agent object for each tool dispatch (the agent is rebuilt
 * per activation/step), so keying `granted` on the object reference is
 * unreliable. The session id is stable for the whole session and is the right
 * once-per-session key; we fall back to the object only for agent-less
 * requests (which the gate never grants anyway).
 */
function agentKey(agent: ApprovalRequestLike['agent']): unknown {
  const sessionId = (agent as { session?: { id?: unknown } } | undefined)?.session?.id;
  return typeof sessionId === 'string' ? sessionId : agent;
}

export interface GateConfig {
  /**
   * Explicit trust opt-in: mint escalation asks are auto-allowed without any
   * user prompt, including the first one (default false — first ask per
   * session goes through the composed answerer chain).
   */
  autoApprove?: boolean;
}

/**
 * Approval gate (B-v2, #25): after the user allows ONE mint escalation for an
 * agent session, later mint escalation asks for that session resolve
 * `allowed-once` immediately — no prompt, no repeat denials, and every grant
 * still lands the seam's `approval/asked` + `approval/decided` audit pair.
 *
 * Mint identity is established from TWO signals so the gate stays robust when
 * one is unavailable in a given harness:
 *
 * 1. **command correlation (authoritative when present)** — the approval ask
 *    carries no command text, so the gate correlates it with the in-flight
 *    bash call through a `callId → command` map filled by `tools/pre-execute`
 *    (which strictly precedes the escalation ask inside the tool body) and
 *    cleared by `tools/post-execute`. When a correlated command exists and is
 *    NOT a bare `mint` invocation, the ask is never treated as mint.
 * 2. **escalation reason fallback** — only consulted when no command could be
 *    correlated. The reason is harness-built as `escalate sandbox to
 *    danger-full-access: <justification>`, and the model is instructed to use
 *    the standard justification `mint`, so a leading `mint` justification
 *    identifies a mint run without depending on the `tools/pre-execute`
 *    delivery/timing that command correlation relies on.
 *
 * Only bare-mint-tagged escalations are ever auto-allowed; every other request
 * delegates to `next()` so the normal answerer chain keeps its decision slot.
 * Any gate failure fails open to that same delegation — it can never break an
 * unrelated approval.
 */
export function installApprovalGate(ctx: DshContext, config: GateConfig): () => void {
  const pending = new Map<string, string>();
  const granted = new Set<unknown>();

  const offPre = ctx.on(
    'tools/pre-execute',
    (
      exec: ToolExecutionLike,
      next: () => Promise<PreToolDecisionLike>,
    ): Promise<PreToolDecisionLike> => {
      try {
        const command = exec.arguments?.command;
        if (exec.callId !== undefined && typeof command === 'string' && BASH_TOOL_NAMES.has(exec.name)) {
          if (pending.size >= MAX_PENDING) {
            const oldest = pending.keys().next().value;
            if (oldest !== undefined) pending.delete(oldest);
          }
          pending.set(String(exec.callId), command);
        }
      } catch {
        // correlation is best-effort — never disturb tool dispatch
      }
      return next();
    },
  );

  const offPost = ctx.on(
    'tools/post-execute',
    (
      exec: ToolExecutionLike,
      _result: ToolResultLike,
      next: () => Promise<PostToolDecisionLike>,
    ): Promise<PostToolDecisionLike> => {
      try {
        if (exec.callId !== undefined) pending.delete(String(exec.callId));
      } catch {
        // stale entries only cost a later failed correlation
      }
      return next();
    },
  );

  /** True when `req` is a bash sandbox escalation the gate may auto-grant. */
  function isMintEscalationRequest(req: ApprovalRequestLike): boolean {
    if (!BASH_TOOL_NAMES.has(req.toolName)) return false;
    if (!isMintEscalation(req.reason)) return false;
    // Command signal is authoritative when the correlation is present.
    if (req.callId !== undefined) {
      const command = pending.get(String(req.callId));
      if (command !== undefined) return isMintCommand(command);
    }
    // No correlated command: fall back to the standardised justification.
    const justification = typeof req.reason === 'string' ? req.reason.slice(ESCALATION_PREFIX.length).trim() : '';
    return justification.length > 0 && MINT_JUSTIFICATION.test(justification);
  }

  const offApproval = ctx.on(
    'approval/request',
    async (
      req: ApprovalRequestLike,
      next: () => Promise<ApprovalOutcomeLike>,
    ): Promise<ApprovalOutcomeLike> => {
      try {
        if (!isMintEscalationRequest(req)) return next();
        const key = agentKey(req.agent);
        if (key === undefined) return next();
        if (config.autoApprove === true || granted.has(key)) return 'allowed-once';
        const outcome = await next();
        if (outcome === 'allowed-once') granted.add(key);
        return outcome;
      } catch {
        // fail open — the composed answerer chain decides instead
        return next();
      }
    },
    { prepend: true },
  );

  return () => {
    offPre();
    offPost();
    offApproval();
  };
}
