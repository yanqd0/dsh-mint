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
 * 跨项目写门禁。
 *
 * 读别的项目台账是寻常工作，放行。对别的项目**写**会推动别人的状态机，所以每会话对每个目标
 * 项目的第一次写会问用户——点名目标项目与动作——此后该会话对同一项目的写直接通过。这次询问
 * 走宿主原生的 `tools/pre-execute` 决定（`kind: 'ask'`），所以没有审批通道的会话（子代理，
 * 策略钉成 `never`）失败关闭：跨项目读能用，写不能。
 *
 * 与 `approval-gate.ts` 的关系——刻意是**两道门禁，不是一道**：
 *
 * 1. 语义不同：那道管 bash 命令需要的*沙箱写权限*；这道管*写谁的台账*。
 * 2. 复用它的每会话一次授权会让此后每次跨项目写都无需确认，而这正是本门禁禁止的。
 * 3. 通道不相交：它只检查 bash 沙箱提权，而 `mint` 工具从不提权。
 *
 * 两者互不绕过：bash 的 `mint -p <other> …` 写由同一份代码分类并自己发问，与任何沙箱授权
 * 无关；这里的授权记忆只由本模块构造的理由所在审批喂养，所以 `autoApprove`（沙箱旋钮）无法
 * 让它静默。
 */

/** 记住的授权数上限，与审批门禁的有界表一致。 */
const MAX_GRANTS = 100;

/** 会话 id 与项目名都不含 NUL，所以用它分隔键。 */
const KEY_SEPARATOR = '\u0000';

/**
 * 一次工具执行或审批请求的会话身份。运行时会为每次分发交出新的 `Agent` 对象，所以只有会话
 * id 稳定——没有它就不记任何授权，下一次写再问。
 *
 * 从 `session-id.ts` 再导出：这条规则与注入通道的去重、mint 写台账共用，所以只住一处。
 */

/** 一次工具执行携带的全部 mint 调用，来自我们读取的那些通道。 */
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

/** 校验目标存在，然后放行、发问或拒绝一次调用。 */
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
  // `-p <本项目>` 是显式点名下的本会话自己的台账：它写的正是默认路径写的地方，所以不是跨项目
  // 写、不得发问。本项目名未知时保持发问——调用方失败关闭。`mint` 工具另外会给出纠正提示。
  if (isOwnProject(cwd, entry, project)) return undefined;
  const sessionId = sessionIdOf(exec?.agent);
  if (sessionId !== undefined && granted.has(`${sessionId}${KEY_SEPARATOR}${project}`)) {
    return undefined;
  }
  const { reason, displayReason } = buildApprovalText(project, invocation.rest);
  return { kind: 'ask', reason, displayReason };
}

/**
 * 注册门禁：`tools/pre-execute` 决定，`approval/request` 记录每（会话, 项目）一次授权。
 *
 * 工具名在碰任何服务或进程之前先判，且只有*被识别为*跨项目的调用才可能因内部失败被拒——判不了
 * 一个就拒绝它而不是放它过去，而其它所有工具调用仍原样委派。
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
        // 决定照旧生效；漏记一次授权只是下次再问一遍。
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
