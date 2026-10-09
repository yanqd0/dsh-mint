import type {
  ApprovalOutcomeLike,
  ApprovalRequestLike,
  DshContext,
  PostToolDecisionLike,
  PreToolDecisionLike,
  ToolExecutionLike,
  ToolResultLike,
} from '../shared/types.js';

/** bash 命令到达宿主所用的工具名。 */
export const BASH_TOOL_NAMES: ReadonlySet<string> = new Set(['bash', 'tool:bash']);
const ESCALATION_PREFIX = 'escalate sandbox to danger-full-access: ';
const MAX_PENDING = 100;
/** 裸 mint 调用的一个 argv token：不含任何 shell 元字符。 */
const MINT_ARG = /^[A-Za-z0-9_./:=+-]+$/;
/** 一次 mint 运行的标准模型理由（由上下文注入规定）。 */
const MINT_JUSTIFICATION = /^mint\b/;

/**
 * `command` 是否是宿主信任通道能安全识别的裸 `mint ...` 调用：可选前导空白、字面 `mint`
 * 词，然后只有普通 argv token。任何 shell 形状（`;`、`&&`、引号、环境变量前缀、重定向）都
 * **不**被识别——这类调用继续走常规的沙箱拒绝与审批路径。
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

/** 一次审批请求是否是 bash 沙箱提权到最宽模式。 */
export function isMintEscalation(reason: string | undefined): boolean {
  return typeof reason === 'string' && reason.startsWith(ESCALATION_PREFIX);
}

/**
 * 某个 agent 授权记忆的稳定身份。运行时就一次工具分发可能交给门禁**另一个** Agent 对象
 * （agent 每次激活/步进都重建），所以把 `granted` 键在对象引用上并不可靠。会话 id 在整个
 * 会话期间稳定，是正确的「每会话一次」键；只有无 agent 的请求才回退到对象（门禁反正不会
 * 授权它们）。
 */
function agentKey(agent: ApprovalRequestLike['agent']): unknown {
  const sessionId = (agent as { session?: { id?: unknown } } | undefined)?.session?.id;
  return typeof sessionId === 'string' ? sessionId : agent;
}

export interface GateConfig {
  /**
   * 显式信任声明：mint 提权请求无需任何用户提示即自动放行，包括第一次（默认 false——每会话
   * 首次询问走组合出的答复链）。
   */
  autoApprove?: boolean;
}

/**
 * 审批门禁（B-v2）：用户为某个 agent 会话放行一次 mint 提权之后，该会话此后的 mint 提权请求
 * 立即解析为 `allowed-once`——不提示、不重复拒绝，而每次授权仍会落下接缝的
 * `approval/asked` + `approval/decided` 审计对。
 *
 * mint 身份由**两个**信号确立，好让门禁在某个信号于给定 harness 不可用时不倒：
 *
 * 1. **命令关联（存在时权威）**——审批请求不携带命令文本，所以门禁经
 *    `tools/pre-execute` 填充、`tools/post-execute` 清除的 `callId → command` 表，把它与
 *    在飞的 bash 调用关联起来（前者严格先于工具体内的提权请求）。当关联到的命令存在且**不是**
 *    裸 `mint` 调用时，该请求永不被当作 mint。
 * 2. **提权理由兜底**——只在关联不到命令时才查。理由是 harness 按
 *    `escalate sandbox to danger-full-access: <justification>` 拼的，而模型被指示使用标准
 *    理由 `mint`，所以以 `mint` 开头的理由无需依赖命令关联所依赖的 `tools/pre-execute`
 *    送达/时序，就能认出一次 mint 运行。
 *
 * 只有带裸 mint 标记的提权才会被自动放行；其余请求一律交给 `next()`，让常规答复链保住它的
 * 决定权。门禁自身的任何失败也 fail open 到同样的委派——它绝不能弄坏一次无关审批。
 */
export function installApprovalGate(ctx: DshContext, config: GateConfig): () => void {
  const pending = new Map<string, string>();
  const granted = new Set<unknown>();

  const offPre = ctx.on(
    'tools/pre-execute',
    (
      exec: ToolExecutionLike,
      next: () => Promise<PreToolDecisionLike>
    ): Promise<PreToolDecisionLike> => {
      try {
        const command = exec.arguments?.command;
        if (
          exec.callId !== undefined &&
          typeof command === 'string' &&
          BASH_TOOL_NAMES.has(exec.name)
        ) {
          if (pending.size >= MAX_PENDING) {
            const oldest = pending.keys().next().value;
            if (oldest !== undefined) pending.delete(oldest);
          }
          pending.set(String(exec.callId), command);
        }
      } catch {
        // 关联是尽力而为——绝不打扰工具分发
      }
      return next();
    }
  );

  const offPost = ctx.on(
    'tools/post-execute',
    (
      exec: ToolExecutionLike,
      _result: ToolResultLike,
      next: () => Promise<PostToolDecisionLike>
    ): Promise<PostToolDecisionLike> => {
      try {
        if (exec.callId !== undefined) pending.delete(String(exec.callId));
      } catch {
        // 残留条目只让稍后的关联失败一次
      }
      return next();
    }
  );

  /** `req` 是否是门禁可以自动授权的 bash 沙箱提权。 */
  function isMintEscalationRequest(req: ApprovalRequestLike): boolean {
    if (!BASH_TOOL_NAMES.has(req.toolName)) return false;
    if (!isMintEscalation(req.reason)) return false;
    // 关联存在时，命令信号是权威。
    if (req.callId !== undefined) {
      const command = pending.get(String(req.callId));
      if (command !== undefined) return isMintCommand(command);
    }
    // 没有关联命令：回退到标准化理由。
    const justification =
      typeof req.reason === 'string' ? req.reason.slice(ESCALATION_PREFIX.length).trim() : '';
    return justification.length > 0 && MINT_JUSTIFICATION.test(justification);
  }

  const offApproval = ctx.on(
    'approval/request',
    async (
      req: ApprovalRequestLike,
      next: () => Promise<ApprovalOutcomeLike>
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
        // fail open——改由组合出的答复链决定
        return next();
      }
    },
    { prepend: true }
  );

  return () => {
    offPre();
    offPost();
    offApproval();
  };
}
