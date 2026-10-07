import { BASH_TOOL_NAMES } from '../mint/approval-gate.js';
import { sessionIdOf } from '../shared/session-id.js';
import { invocationsOf } from '../mint/cross-project-gate.js';
import { hasMintWrite, noteRecordGapNotified } from './session-ledger.js';
import { EXIT_PLAN_MODE } from './planbind.js';
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
 * `git commit` inside a shell command line (#110).
 *
 * The existing shape, plus the `-c <k=v>` / `-C <dir>` option pairs that
 * scripted commits use (`git -c user.name=… commit`). Options before `git`
 * (`uv run git commit`) need no handling: the pattern is anchored on `git`
 * itself.
 */
const COMMIT_IN_COMMAND = /\bgit\s+(?:-[cC]\s+\S+\s+)*commit\b/;

/**
 * `git commit` as an argv array (#110).
 *
 * `uv run git commit …` reaches the plugin as `['run','git','commit',…]`
 * (the `uv` tool is a foreign plugin's tool that spawns without a shell), so the
 * argv channel has to read tokens, not a command line. Matching is on exact
 * tokens: prose inside one token (an issue title mentioning a commit) cannot
 * match.
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
 * True when a tool call ran a git commit (#110).
 *
 * Two channels, by argument *shape* rather than by tool name:
 *
 * - a shell command line (`bash`'s `command`) — the name is still checked, so an
 *   unrelated tool carrying a `command` field cannot trigger the reminder;
 * - an argv array (`args`) — the shape the `uv` tool uses. Its name belongs to
 *   another plugin, so shape matching keeps this plugin decoupled from it.
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
 * Failure markers a host or tool appends to a model-facing result.
 *
 * `isError` alone does **not** mean "the command failed": the bash tool reports a
 * non-zero command exit as a *completed* call whose text ends with
 * `[exit code: N]` (`dsh-tool-bash` `renderResult`, and its own description tells
 * the model to check the marker). The `uv` tool — a foreign plugin — reports its
 * own failures the same way through `notes` (`dsh-dev-dsh` `src/uv/run.ts`), which
 * is how `uv run git commit` renders a rejected commit. Verified live (#110): a
 * commit that failed with "nothing to commit" still carried no `isError`.
 */
const RESULT_FAILURE =
  /\[(?:exit code: [1-9]\d*|killed by signal: [^\]]+|timed out after \d+ms|stopped: [^\]]+)\]/;

/**
 * True when a tool result reports a failed run, not merely a host-level error.
 *
 * Searched for anywhere in the text rather than anchored at its end: both hosts
 * of this signal append further marker lines, and a missing marker (an unknown
 * format) must fail *open* to the existing behaviour — no reminder — instead of
 * claiming a commit that may not exist.
 */
export function isFailedResult(result: ToolResultLike): boolean {
  if (result.isError) return true;
  return result.content.some((block) => block.type === 'text' && RESULT_FAILURE.test(block.text));
}

/**
 * `tools/post-execute` listener: after a git commit, append a mint registration
 * reminder to the model-facing content. Accept + content keeps the original
 * tool value and content — only a text block is appended (enrich, not replace).
 *
 * A failed call is skipped (#110): a pre-commit hook, a rejected commit or
 * "nothing to commit" all mean no commit was recorded, and the previous
 * unconditional reminder fired exactly then.
 */
export async function commitReminderListener(
  exec: ToolExecutionLike,
  result: ToolResultLike,
  next: () => Promise<PostToolDecisionLike>,
): Promise<PostToolDecisionLike> {
  if (isFailedResult(result) || !isGitCommit(exec)) {
    return next();
  }
  const reminder: ContentBlockLike = { type: 'text', text: COMMIT_REMINDER };
  return { kind: 'accept', content: [...result.content, reminder] };
}

/** Register the commit reminder on `tools/post-execute`. */
export function installCommitReminder(ctx: DshContext): () => void {
  return ctx.on('tools/post-execute', commitReminderListener);
}

/**
 * Reminder appended after a mint call that moves issue/plan state (#119).
 *
 * The host's todo panel (`todo_write` → `conversation.input.dock`) is the
 * human's progress view inside a session, and its `todos` projection resets to
 * `null` on every `turn/start` (verified against `@deepseek-ai/dsh-tool-todo`
 * and `dsh-client-ui-conversation` in 0.2.0-rc.2): a list written once early in
 * a long turn drifts away from the mint ledger, which is exactly how a session
 * once reported `#54 in_progress` while mint already had it in `test`.
 *
 * The skill owns the discipline (`references/flow-impl.md`); this notice delivers
 * it at the moment the ledger changes, which is when the panel starts to
 * disagree. It only nudges — the list stays model-authored, because it is the
 * model's step breakdown, not a mirror of the issue rows.
 *
 * #159 在此补上粒度：清单**一项对应一个 issue**（条目只写 issue，不写批次名/DAG
 * 节点名），并点明重置时机——`todos` 投影每个 `turn/start` 都清空，所以不是写一次就够，
 * 每次状态变更后都要整份重写。
 */
export const TODO_SYNC_REMINDER =
  '[mint] issue 状态已变更——同步宿主 todo：todo_write 整份重写清单，一项对应一个 issue' +
  '（条目只写 issue，不写批次名/DAG 节点名），让每项的 status 与 mint 一致；' +
  '宿主的 todos 投影在每个 turn/start 重置，所以每次状态变更后都要全量重写（面板是人类看进度的入口）。';

/**
 * True when the call moves mint issue/plan state.
 *
 * Matching is on the parsed invocation ({@link invocationsOf}), so the `mint`
 * tool and a recognised bash fallback behave identically and leading `-p`/global
 * flags are already stripped. Reads (`issue list`, `plan show`, …) never match.
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
 * `tools/post-execute` listener: after a successful `issue state` /
 * `plan plan` / `plan close` call, append the todo-sync reminder.
 *
 * Skipped when the call failed (a rejected transition moved nothing, the same
 * rule as the commit reminder #110) and for subagent sessions — the panel it
 * speaks about belongs to the root agent's session (#113).
 */
export async function todoSyncReminderListener(
  exec: ToolExecutionLike,
  result: ToolResultLike,
  next: () => Promise<PostToolDecisionLike>,
): Promise<PostToolDecisionLike> {
  const delegationDepth = exec.agent?.session?.header?.delegationDepth ?? 0;
  if (isFailedResult(result) || delegationDepth > 0 || !todoSyncChanged(exec)) {
    return next();
  }
  const reminder: ContentBlockLike = { type: 'text', text: TODO_SYNC_REMINDER };
  return { kind: 'accept', content: [...result.content, reminder] };
}

/** Register the todo-sync reminder on `tools/post-execute`. */
export function installTodoSyncReminder(ctx: DshContext): () => void {
  return ctx.on('tools/post-execute', todoSyncReminderListener);
}

/**
 * Model-facing notice for a session that leaves plan mode with nothing recorded
 * (#111). It names the paths, not the workflow: the mint skill owns the flow
 * (`references/flow-impl.md`), and this text only has to make the gap visible at
 * the moment the work starts.
 */
export const SESSION_RECORD_REMINDER =
  '[mint] 本会话尚无 mint 写操作——项目里的 running plan 未必是本次工作的记录。' +
  '若接下来会改码，按 mint skill 流程先补记录：' +
  'plan create（挂当前 running milestone）+ 拆 issue 后 plan plan，或 plan attach 接管既有 plan；' +
  '首个改码 issue 先 mint({args:["issue","state","start","<id>"]})；' +
  '已完成的 commit 逐条 mint({args:["issue","state","commit","<id>","--sha","<前7位>"]})。';

/**
 * `tools/post-execute` listener: when `exit_plan_mode` is approved and this
 * session has performed no mint write, append the notice (#111).
 *
 * Why a notice and not a denial: the plan gate already requires a running mint
 * plan, but that is a project-level fact — a session can exit plan mode while
 * the only running plan belongs to someone else's work, and that is how six
 * commits once landed without a trace. The intent stays "records must exist,
 * order may vary", so the session is told rather than trapped; the same ledger is
 * what a future hard gate would read.
 *
 * A session whose id is unknown gets no notice (nothing can be attributed), and
 * a rejected or cancelled exit is left alone (see {@link isFailedResult} — the
 * host reports that as an error, and the guard covers a marker-only failure too).
 */
export async function sessionRecordReminderListener(
  exec: ToolExecutionLike,
  result: ToolResultLike,
  next: () => Promise<PostToolDecisionLike>,
): Promise<PostToolDecisionLike> {
  if (exec.name !== EXIT_PLAN_MODE || isFailedResult(result)) {
    return next();
  }
  const sessionId = sessionIdOf(exec.agent);
  // #116: this delivery satisfies the overview channel's one-shot line too, so a
  // single exit is never announced twice — marked on the call, because the host
  // appends the `plan/mode` event only at the next request assembly.
  noteRecordGapNotified(sessionId);
  if (sessionId === undefined || hasMintWrite(sessionId)) {
    return next();
  }
  const reminder: ContentBlockLike = { type: 'text', text: SESSION_RECORD_REMINDER };
  return { kind: 'accept', content: [...result.content, reminder] };
}

/** Register the plan-mode record notice on `tools/post-execute`. */
export function installSessionRecordReminder(ctx: DshContext): () => void {
  return ctx.on('tools/post-execute', sessionRecordReminderListener);
}

/**
 * `tools/result` observer: on a failed tool call, emit an observable hint to
 * register the failure as a mint issue. The event is emit-only, so this never
 * alters the frozen result; listener failures are contained by the host.
 */
export function installFailureSignal(ctx: DshContext): () => void {
  return ctx.on('tools/result', (exec: ToolExecutionLike, result: ToolResultLike) => {
    if (result.isError) {
      process.stderr.write(FAILURE_HINT(exec.name));
    }
  });
}

/**
 * 轮询子代理的词（#160）：命令文本或 argv token 里出现**独立**的 `list_agents`
 * 才算命中（`\b` 把 `foo_list_agents` 这类同名前缀排除在外）。
 */
const LIST_AGENTS_WORD = /\blist_agents\b/;

/** 以 `sleep` 起头的 shell 命令（`sleep 120`；`sleepy 5` 不算）。 */
const SLEEP_COMMAND = /^sleep\s/;

/**
 * 等待子代理时「不要 `sleep`、不要轮询」的提示文案（#160）。
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
 * argv 形态的命中判定（#160）：`['sleep', …]`、`['bash'|'sh','-c','…']` 里的命令，
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
 * True when a tool call is a bash `sleep` or a `list_agents` poll (#160).
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
 * `tools/post-execute` listener：调用里出现 `sleep` 空等或 `list_agents` 轮询时，
 * 在结果末尾追加 {@link sleepPollHint}（#160）。
 *
 * enrich 而非 deny：`sleep` 本身合法，这里只把「通知会被推迟」这条实测事实摆在模型眼前。
 * 失败调用（{@link isFailedResult}）不提示——那时代码根本没跑起来。检测或拼装出任何异常都
 * 直接 `next()`：提示是附加物，绝不能挡住工具结果。
 */
export async function sleepPollReminderListener(
  exec: ToolExecutionLike,
  result: ToolResultLike,
  next: () => Promise<PostToolDecisionLike>,
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

/** Register the sleep/poll hint on `tools/post-execute` (#160). */
export function installSleepHint(ctx: DshContext): () => void {
  return ctx.on('tools/post-execute', sleepPollReminderListener);
}

/**
 * mint 的 SQLite 报错原文（#60）。常量导出，好让测试与文档引用同一串，不各写一份。
 *
 * 它是**症状**而非根因：workspace-write 沙箱下走 bash 跑 mint（连 `mint list` 这种只读命令）
 * 也会这么报——SQLite 连只读查询都要写 journal，所以看到它就说明「db 目录对本次执行只读」。
 */
export const READONLY_DB_SYMPTOM = 'attempt to write a readonly database';

/**
 * 看见 {@link READONLY_DB_SYMPTOM} 时追加的可诊断提示（#60）。
 *
 * 模型最可能的误判是「mint 坏了 / db 损坏」，于是绕路重试甚至改写数据；这句话把它拉回
 * 正确的两条路：宿主 `mint` 工具（插件进程内 spawn，不受会话沙箱约束）或常规沙箱提权。
 */
export const BASH_DIAGNOSTIC_HINT =
  '[mint] 沙箱挡住 mint 的 db 写（即使只读命令也要写 journal）。' +
  '改用宿主 mint 工具；确需 bash 时按常规沙箱提权审批重试，或把 --db 指向可写目录。';

/**
 * True when a tool result carries the SQLite readonly-db symptom (#60).
 *
 * 只认 `content` 里的文本：`bash` 把非零退出当**成功**调用返回（见 {@link isFailedResult}），
 * 而且这里不依赖工具名——同样的症状经别的构造出现时，提示一样成立。
 */
export function isReadonlyDbFailure(result: ToolResultLike): boolean {
  return result.content.some(
    (block) => block.type === 'text' && block.text.includes(READONLY_DB_SYMPTOM),
  );
}

/**
 * `tools/post-execute` listener：结果里出现只读 db 症状时追加 {@link BASH_DIAGNOSTIC_HINT}（#60）。
 *
 * 只 append 一块 text，原 content 与工具值都不动；任何异常都 `next()`，
 * 提示永远不能改变一次已经发生的失败。
 */
export async function readonlyDbHintListener(
  _exec: ToolExecutionLike,
  result: ToolResultLike,
  next: () => Promise<PostToolDecisionLike>,
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

/** Register the readonly-db diagnostic hint on `tools/post-execute` (#60). */
export function installReadonlyDbHint(ctx: DshContext): () => void {
  return ctx.on('tools/post-execute', readonlyDbHintListener);
}
