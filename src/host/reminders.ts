import { BASH_TOOL_NAMES } from '../mint/approval-gate.js';
import { sessionIdOf } from '../shared/session-id.js';
import { invocationsOf } from '../mint/cross-project-gate.js';
import { hasMintWrite, noteRecordGapNotified } from './session-ledger.js';
import { EXIT_PLAN_MODE } from './planbind.js';
import { planModeState } from './plan-mode.js';
import type {
  ContentBlockLike,
  DshContext,
  PostToolDecisionLike,
  ToolExecutionLike,
  ToolResultLike,
} from '../shared/types.js';

const COMMIT_REMINDER =
  '已提交代码——记得用 mint 工具登记：' +
  'mint({args:["issue","state","commit","<id>","--sha","<前7位>"]})；' +
  '同 plan 全部测试通过后 mint({args:["plan","close","<plan>","--test-cmd","<命令>"]})。';

const FAILURE_HINT = (toolName: string): string =>
  `[mint] tool ${toolName} failed — consider registering an issue: ` +
  `mint({args:["issue","add","<标题>","--kind","problem"]})\n`;

/**
 * 命令行里的 `git commit`。
 *
 * 现有形状，外加脚本化提交会用的 `-c <k=v>` / `-C <dir>` 选项对
 * （`git -c user.name=… commit`）。`git` 之前的选项（`uv run git commit`）无需处理：
 * 模式锚定在 `git` 本身。
 */
const COMMIT_IN_COMMAND = /\bgit\s+(?:-[cC]\s+\S+\s+)*commit\b/;

/**
 * argv 数组形态的 `git commit`。
 *
 * `uv run git commit …` 到达插件时是 `['run','git','commit',…]`（`uv` 工具是外部插件的
 * 工具，spawn 时不过 shell），所以 argv 通道必须读 token 而不是命令行。匹配按**整
 * token**：某个 token 内部的散文（提到 commit 的 issue 标题）不可能命中。
 */
export function isCommitArgv(tokens: readonly string[]): boolean {
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index] !== 'git') continue;
    let next = index + 1;
    while ((tokens[next] === '-c' || tokens[next] === '-C') && tokens[next + 1] !== undefined) {
      next += 2;
    }
    if (tokens[next] === 'commit') return true;
  }
  return false;
}

/**
 * 一次工具调用是否跑了 git commit。
 *
 * 两个通道，按参数**形状**而非工具名判定：
 *
 * - shell 命令行（`bash` 的 `command`）——名字仍要判，所以碰巧带 `command` 字段的无关
 *   工具不会触发提醒；
 * - argv 数组（`args`）——`uv` 工具用的形状。它的名字属于别的插件，按形状判定让本插件
 *   与它解耦。
 */
export function isGitCommit(exec: ToolExecutionLike): boolean {
  if (BASH_TOOL_NAMES.has(exec.name)) {
    const command = exec.arguments.command;
    if (typeof command === 'string' && COMMIT_IN_COMMAND.test(command)) return true;
  }
  const argv = exec.arguments.args;
  if (
    Array.isArray(argv) &&
    argv.length > 0 &&
    argv.every((token): token is string => typeof token === 'string')
  ) {
    return isCommitArgv(argv);
  }
  return false;
}

/**
 * 宿主或工具追加到面向模型的结果里的失败标记。
 *
 * 单看 `isError` **并不**等于「命令失败」：bash 工具把非零退出报成一次*已完成*的调用，
 * 只是文本以 `[exit code: N]` 结尾（`dsh-tool-bash` 的 `renderResult`，其描述也告诉
 * 模型检查这个标记）。`uv` 工具——外部插件——通过 `notes` 以同样方式报告自己的失败
 * （`dsh-dev-dsh` 的 `src/uv/run.ts`），`uv run git commit` 被拒时就长这样。实测：
 * 因 “nothing to commit” 失败的提交照样不带 `isError`。
 */
const RESULT_FAILURE =
  /\[(?:exit code: [1-9]\d*|killed by signal: [^\]]+|timed out after \d+ms|stopped: [^\]]+)\]/;

/**
 * 工具结果是否报告了一次失败的运行，而不只是宿主级错误。
 *
 * 在文本**任意位置**搜索而不是锚定结尾：该信号的两个宿主都会再追加标记行，而标记缺失
 * （未知格式）必须 fail **open** 到现有行为——不加提醒，而不是宣称一次可能不存在的提交。
 */
export function isFailedResult(result: ToolResultLike): boolean {
  if (result.isError) return true;
  return result.content.some((block) => block.type === 'text' && RESULT_FAILURE.test(block.text));
}

/**
 * `tools/post-execute` 监听器：git commit 之后，在面向模型的内容后追加 mint 登记提醒。
 * 用 accept + content 保留原工具值与内容——只追加一块文本（enrich，不是 replace）。
 *
 * 失败的调用跳过：pre-commit hook、被拒的提交或 “nothing to commit” 都意味着没有提交
 * 被记下，而此前无条件的提醒恰恰在这些时刻乱响。
 */
export async function commitReminderListener(
  exec: ToolExecutionLike,
  result: ToolResultLike,
  next: () => Promise<PostToolDecisionLike>
): Promise<PostToolDecisionLike> {
  if (isFailedResult(result) || !isGitCommit(exec)) {
    return next();
  }
  const reminder: ContentBlockLike = { type: 'text', text: COMMIT_REMINDER };
  return { kind: 'accept', content: [...result.content, reminder] };
}

/** 在 `tools/post-execute` 上注册提交提醒。 */
export function installCommitReminder(ctx: DshContext): () => void {
  return ctx.on('tools/post-execute', commitReminderListener);
}

/**
 * mint 调用推进 issue/plan 状态后追加的提醒。
 *
 * 宿主的 todo 面板（`todo_write` → `conversation.input.dock`）是人在会话内的进度视图，
 * 而它的 `todos` 投影在每个 `turn/start` 都被清成 `null`（对 0.2.0-rc.2 的
 * `@deepseek-ai/dsh-tool-todo` 与 `dsh-client-ui-conversation` 实测过）：早早在长
 * 回合里写一次的清单会离 mint 台账越来越远，本会话曾因此在 mint 已把 issue 推进到
 * `test` 时报成 `in_progress`。
 *
 * 纪律本身归 skill（`references/flow-impl.md`）；这条提醒在台账变更的当下送达，也就是
 * 面板开始不一致的时刻。它只轻推——清单仍是模型写的，那是模型的步骤分解，不是 issue 行的
 * 镜像。
 *
 * 粒度在此补上：清单**一项对应一个 issue**（条目只写 issue，不写批次名/DAG 节点名），
 * 并点明重置时机——`todos` 投影每个 `turn/start` 都清空，所以不是写一次就够，每次状态
 * 变更后都要整份重写。
 */
export const TODO_SYNC_REMINDER =
  '[mint] issue 状态已变更——同步宿主 todo：todo_write 整份重写清单，一项对应一个 issue' +
  '（条目只写 issue，不写批次名/DAG 节点名），让每项的 status 与 mint 一致；' +
  '宿主的 todos 投影在每个 turn/start 重置，所以每次状态变更后都要全量重写（面板是人类看进度的入口）。';

/**
 * 调用是否推进了 mint 的 issue/plan 状态。
 *
 * 匹配发生在解析后的调用上（{@link invocationsOf}），所以 `mint` 工具与被识别的 bash
 * 兜底行为一致，且前导 `-p`/全局参数已被剥掉。只读命令（`issue list`、`plan show`…）
 * 永不命中。
 */
export function todoSyncChanged(exec: ToolExecutionLike): boolean {
  return invocationsOf(exec).some((invocation) => {
    const [root, leaf] = invocation.rest;
    if (root === 'issue') return leaf === 'state';
    if (root === 'plan') return leaf === 'plan' || leaf === 'close';
    return false;
  });
}

/**
 * `tools/post-execute` 监听器：成功的 `issue state` / `plan plan` / `plan close` 之后
 * 追加 todo 同步提醒。
 *
 * 调用失败时跳过（被拒的转移什么都没动，与提交提醒同一条规则），子代理会话也跳过——
 * 它谈论的那块面板属于根代理的会话。
 */
export async function todoSyncReminderListener(
  exec: ToolExecutionLike,
  result: ToolResultLike,
  next: () => Promise<PostToolDecisionLike>
): Promise<PostToolDecisionLike> {
  const delegationDepth = exec.agent?.session?.header?.delegationDepth ?? 0;
  if (isFailedResult(result) || delegationDepth > 0 || !todoSyncChanged(exec)) {
    return next();
  }
  const reminder: ContentBlockLike = { type: 'text', text: TODO_SYNC_REMINDER };
  return { kind: 'accept', content: [...result.content, reminder] };
}

/** 在 `tools/post-execute` 上注册 todo 同步提醒。 */
export function installTodoSyncReminder(ctx: DshContext): () => void {
  return ctx.on('tools/post-execute', todoSyncReminderListener);
}

/**
 * 会话离开计划模式却什么都没登记时面向模型的提醒。
 *
 * 它只点名路径、不复述流程：流程归 mint skill（`references/flow-impl.md`），这段文字
 * 只需在工作开始的那一刻把缺口显出来。
 */
export const SESSION_RECORD_REMINDER =
  '[mint] 本会话尚无 mint 写操作——项目里的 running plan 未必是本次工作的记录。' +
  '若接下来会改码，按 mint skill 流程先补记录：' +
  'plan create（挂当前 running milestone）+ 拆 issue 后 plan plan，或 plan attach 接管既有 plan；' +
  '首个改码 issue 先 mint({args:["issue","state","start","<id>"]})；' +
  '已完成的 commit 逐条 mint({args:["issue","state","commit","<id>","--sha","<前7位>"]})。';

/**
 * `tools/post-execute` 监听器：`exit_plan_mode` 被批准且本会话尚无 mint 写时追加提醒。
 *
 * 为什么是提醒而不是拒绝：计划门禁已要求项目里有一个 running 的 mint plan，但那是项目级
 * 事实——会话可以在唯一 running 计划属于别人工作时退出计划模式，曾有六次提交因此没留痕。
 * 口径仍是「记录要有，顺序可变」，所以告诉会话而不是卡住它；将来上硬门禁读的也是这个台账。
 *
 * 会话 id 未知时不给提醒（无从归属），被拒或取消的退出也不碰（见 {@link isFailedResult}
 * ——宿主把它报成 error，而守卫也覆盖只有标记的失败）。
 */
export async function sessionRecordReminderListener(
  exec: ToolExecutionLike,
  result: ToolResultLike,
  next: () => Promise<PostToolDecisionLike>
): Promise<PostToolDecisionLike> {
  if (exec.name !== EXIT_PLAN_MODE || isFailedResult(result)) {
    return next();
  }
  const sessionId = sessionIdOf(exec.agent);
  // 这次送达同时满足概览通道的一次性行，所以一次退出不会被播报两次——在调用时标记，
  // 因为主机要到下次请求装配才追加 `plan/mode` 事件。
  noteRecordGapNotified(sessionId);
  if (sessionId === undefined || hasMintWrite(sessionId)) {
    return next();
  }
  const reminder: ContentBlockLike = { type: 'text', text: SESSION_RECORD_REMINDER };
  return { kind: 'accept', content: [...result.content, reminder] };
}

/** 在 `tools/post-execute` 上注册计划模式记录提醒。 */
export function installSessionRecordReminder(ctx: DshContext): () => void {
  return ctx.on('tools/post-execute', sessionRecordReminderListener);
}

/**
 * `tools/result` 观察者：工具调用失败时，输出一条可观察的提示，建议把失败登记成 mint
 * issue。事件只发不收，所以它绝不改动已冻结的结果；监听器异常由宿主兜住。
 */
export function installFailureSignal(ctx: DshContext): () => void {
  return ctx.on('tools/result', (exec: ToolExecutionLike, result: ToolResultLike) => {
    if (result.isError) {
      process.stderr.write(FAILURE_HINT(exec.name));
    }
  });
}

/** 轮询子代理的词：命中需出现**独立**的 `list_agents`（`\b` 排除 `foo_list_agents`）。 */
const LIST_AGENTS_WORD = /\blist_agents\b/;

/** 以 `sleep` 起头的 shell 命令（`sleep 120`；`sleepy 5` 不算）。 */
const SLEEP_COMMAND = /^sleep\s/;

/**
 * 等待子代理时「不要 `sleep`、不要轮询」的提示文案。
 *
 * skill 里的「不 sleep」口径是软约束，本轮实测被违反 3 次（共 ~9.3 min），
 * 所以加一道只提示不拦截的机器兜底：合法 `sleep`（等端口、重试）不该被拦，
 * 重复提示的成本也远低于误拦。
 */
export const sleepPollHint =
  '[mint] 等子代理不要 bash sleep、也不要轮询 list_agents：结算通知会自动到达，' +
  'sleep 反而把通知推迟到 sleep 结束之后（运行时会在子代理结算时以 follow-up 轮次唤醒本会话）。' +
  '没有独立工作就地结束本轮；真被阻塞才 job_output(<id>, wait: true)（只用于一次性后台 job，不用于子代理）。';

/** 一段文本是否在 `sleep` 空等或轮询 `list_agents`（`trimStart` 容忍前导空白）。 */
function hasSleepPollText(text: string): boolean {
  return SLEEP_COMMAND.test(text.trimStart()) || LIST_AGENTS_WORD.test(text);
}

/**
 * argv 形态的命中判定：`['sleep', …]`、`['bash'|'sh','-c','…']` 里的命令，
 * 以及数组里出现独立的 `list_agents` token。
 *
 * 相邻 token 拼接后再匹配，是为了不在「词被切成两段 token」这种构造上漏判；
 * 单独判 `token === 'list_agents'` 则覆盖下一 token 是普通词（拼接后反而没有词边界）的情形。
 */
export function isSleepPollArgv(tokens: readonly string[]): boolean {
  if (tokens[0] === 'sleep') return true;
  const [head, flag, inline] = tokens;
  if ((head === 'bash' || head === 'sh') && flag === '-c' && inline !== undefined) {
    if (hasSleepPollText(inline)) return true;
  }
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? '';
    if (token === 'list_agents') return true;
    if (LIST_AGENTS_WORD.test(token + (tokens[index + 1] ?? ''))) return true;
  }
  return false;
}

/**
 * True when a tool call is a bash `sleep` or a `list_agents` poll.
 *
 * 两个通道，按**参数形态**判定（与 {@link isGitCommit} 同一套口径）：
 *
 * - `command` 是 shell 命令行——工具名仍走 {@link BASH_TOOL_NAMES}，别的工具恰好也带
 *   `command` 字段时不会误触发；
 * - `args` 是 argv 数组——`uv` 这类外部插件直接 spawn、不过 shell，所以只认形状、不认名字。
 *
 * `sleep` 必须带参数（`/^sleep\s/`），否则 `sleepy` 之类的词会被误判。
 */
export function isSleepPoll(exec: ToolExecutionLike): boolean {
  if (BASH_TOOL_NAMES.has(exec.name)) {
    const command = exec.arguments.command;
    if (typeof command === 'string' && hasSleepPollText(command)) return true;
  }
  const argv = exec.arguments.args;
  if (
    Array.isArray(argv) &&
    argv.length > 0 &&
    argv.every((token): token is string => typeof token === 'string')
  ) {
    return isSleepPollArgv(argv);
  }
  return false;
}

/**
 * `tools/post-execute` 监听器：调用里出现 `sleep` 空等或 `list_agents` 轮询时，在结果
 * 末尾追加 {@link sleepPollHint}。
 *
 * enrich 而非 deny：`sleep` 本身合法，这里只把「通知会被推迟」这条实测事实摆在模型眼前。
 * 失败调用（{@link isFailedResult}）不提示——那时代码根本没跑起来。检测或拼装出任何异常
 * 都直接 `next()`：提示是附加物，绝不能挡住工具结果。
 */
export async function sleepPollReminderListener(
  exec: ToolExecutionLike,
  result: ToolResultLike,
  next: () => Promise<PostToolDecisionLike>
): Promise<PostToolDecisionLike> {
  try {
    if (isFailedResult(result) || !isSleepPoll(exec)) {
      return next();
    }
    const hint: ContentBlockLike = { type: 'text', text: sleepPollHint };
    return { kind: 'accept', content: [...result.content, hint] };
  } catch {
    return next();
  }
}

/** 在 `tools/post-execute` 上注册 sleep/轮询提示。 */
export function installSleepHint(ctx: DshContext): () => void {
  return ctx.on('tools/post-execute', sleepPollReminderListener);
}

/**
 * mint 的 SQLite 报错原文。常量导出，好让测试与文档引用同一串，不各写一份。
 *
 * 它是**症状**而非根因：workspace-write 沙箱下走 bash 跑 mint（连 `mint list` 这种只读
 * 命令）也会这么报——SQLite 连只读查询都要写 journal，所以看到它就说明「db 目录对本次
 * 执行只读」。
 */
export const READONLY_DB_SYMPTOM = 'attempt to write a readonly database';

/**
 * 看见 {@link READONLY_DB_SYMPTOM} 时追加的可诊断提示。
 *
 * 模型最可能的误判是「mint 坏了 / db 损坏」，于是绕路重试甚至改写数据；这句话把它拉回
 * 正确的两条路：宿主 `mint` 工具（插件进程内 spawn，不受会话沙箱约束）或常规沙箱提权。
 */
export const BASH_DIAGNOSTIC_HINT =
  '[mint] 沙箱挡住 mint 的 db 写（即使只读命令也要写 journal）。' +
  '改用宿主 mint 工具；确需 bash 时按常规沙箱提权审批重试，或把 --db 指向可写目录。';

/**
 * True when a tool result carries the SQLite readonly-db symptom.
 *
 * 只认 `content` 里的文本：`bash` 把非零退出当**成功**调用返回（见 {@link isFailedResult}），
 * 而且这里不依赖工具名——同样的症状经别的构造出现时，提示一样成立。
 */
export function isReadonlyDbFailure(result: ToolResultLike): boolean {
  return result.content.some(
    (block) => block.type === 'text' && block.text.includes(READONLY_DB_SYMPTOM)
  );
}

/**
 * `tools/post-execute` listener：结果里出现只读 db 症状时追加 {@link BASH_DIAGNOSTIC_HINT}。
 *
 * 只 append 一块 text，原 content 与工具值都不动；任何异常都 `next()`，
 * 提示永远不能改变一次已经发生的失败。
 */
export async function readonlyDbHintListener(
  _exec: ToolExecutionLike,
  result: ToolResultLike,
  next: () => Promise<PostToolDecisionLike>
): Promise<PostToolDecisionLike> {
  try {
    if (!isReadonlyDbFailure(result)) {
      return next();
    }
    const hint: ContentBlockLike = { type: 'text', text: BASH_DIAGNOSTIC_HINT };
    return { kind: 'accept', content: [...result.content, hint] };
  } catch {
    return next();
  }
}

/** 在 `tools/post-execute` 上注册只读 db 诊断提示。 */
export function installReadonlyDbHint(ctx: DshContext): () => void {
  return ctx.on('tools/post-execute', readonlyDbHintListener);
}

/** 进入计划模式时给一次的执行形态提示。 */
export const PLAN_ENTRY_HINT =
  '[mint] 已进入计划模式——按 mint skill 的默认执行形态：调研/实现/测试各自派独立子代理' +
  '（串行也逐个派，main 不亲自实现），实现阶段一节点一棵 worktree（dev/test 对走两级委派）；' +
  '细节见 mint skill。';

/**
 * 记住的会话数上限；与其它会话级表同值（`session-ledger.ts` / `context.ts` 都是 100）。
 *
 * 有界是泄漏守卫：本模块活得比进程服务的任何会话都久。最旧的先被挤出——被挤出的会话
 * 至多多收一次提示，比无界表便宜。
 */
export const MAX_PLAN_HINTED_SESSIONS = 100;

/** 已收到过入口提示的会话，最旧的在前。 */
const planHinted = new Set<string>();

/** 忘掉全部会话（测试用：状态不许在用例间串）。 */
export function resetPlanEntryHint(): void {
  planHinted.clear();
}

/**
 * `tools/post-execute` 监听器：进入计划模式后的第一条成功调用，追加一次默认执行形态提示。
 *
 * 为什么走这条通道：宿主的 `session/event` 里那条 `plan/mode` 只发不收，插件改不了它的
 * 内容；概览 provider 又拿不到 `exec`，判不出本次调用是否落在计划模式里。在工具结果后补
 * 一块文本，是唯一「跟着某次调用到达模型」的位置。
 *
 * 为什么是软的：执行形态是纪律、不是拒绝一次调用的理由，所以它只提示不拦（`accept` 加
 * 内容，永不 deny/block），每会话只播一次，判据读不到（无投影、无会话 id、子代理会话）就
 * 沉默；整段 try/catch，任何异常都落回 `next()`。
 */
export async function planEntryHintListener(
  exec: ToolExecutionLike,
  result: ToolResultLike,
  next: () => Promise<PostToolDecisionLike>,
  ctx?: DshContext
): Promise<PostToolDecisionLike> {
  try {
    if (isFailedResult(result)) return next();
    if ((exec.agent?.session?.header?.delegationDepth ?? 0) > 0) return next();
    const sessionId = sessionIdOf(exec.agent);
    if (sessionId === undefined || planHinted.has(sessionId)) return next();
    if (planModeState(ctx, exec)?.active !== true) return next();
    if (planHinted.size >= MAX_PLAN_HINTED_SESSIONS) {
      const oldest = planHinted.values().next().value;
      if (oldest !== undefined) planHinted.delete(oldest);
    }
    planHinted.add(sessionId);
    const hint: ContentBlockLike = { type: 'text', text: PLAN_ENTRY_HINT };
    return { kind: 'accept', content: [...result.content, hint] };
  } catch {
    return next();
  }
}

/** 在 `tools/post-execute` 上注册进计划模式的一次性提示。 */
export function installPlanEntryHint(ctx: DshContext): () => void {
  return ctx.on('tools/post-execute', (exec, result, next) =>
    planEntryHintListener(exec, result, next, ctx)
  );
}
