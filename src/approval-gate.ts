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
 * agent in this session, later mint escalation asks for that agent resolve
 * `allowed-once` immediately — no prompt, no repeat denials, and every grant
 * still lands the seam's `approval/asked` + `approval/decided` audit pair.
 *
 * The approval ask carries no command text, so the gate correlates it with the
 * in-flight bash call through a `callId → command` map filled by
 * `tools/pre-execute` (which strictly precedes the escalation ask inside the
 * tool body) and cleared by `tools/post-execute`. Only bare `mint` invocations
 * are ever auto-allowed; every other request delegates to `next()` so the
 * normal answerer chain keeps its decision slot. Any gate failure fails open
 * to that same delegation — it can never break an unrelated approval.
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

  const offApproval = ctx.on(
    'approval/request',
    async (
      req: ApprovalRequestLike,
      next: () => Promise<ApprovalOutcomeLike>,
    ): Promise<ApprovalOutcomeLike> => {
      try {
        if (!BASH_TOOL_NAMES.has(req.toolName)) return next();
        if (req.callId === undefined || !isMintEscalation(req.reason)) return next();
        const command = pending.get(String(req.callId));
        if (command === undefined || !isMintCommand(command)) return next();
        if (config.autoApprove === true || granted.has(req.agent)) return 'allowed-once';
        const outcome = await next();
        if (outcome === 'allowed-once') granted.add(req.agent);
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
