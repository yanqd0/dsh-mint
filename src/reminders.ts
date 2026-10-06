import { sessionIdOf } from './session-id.js';
import { invocationsOf } from './cross-project-gate.js';
import { hasMintWrite, noteRecordGapNotified } from './session-ledger.js';
import { EXIT_PLAN_MODE } from './planbind.js';
import type {
  ContentBlockLike,
  DshContext,
  PostToolDecisionLike,
  ToolExecutionLike,
  ToolResultLike,
} from './types.js';

const COMMIT_REMINDER =
  '已提交代码——记得用 mint 工具登记：' +
  'mint({args:["issue","state","commit","<id>","--sha","<前7位>"]})；' +
  '同 plan 全部测试通过后 mint({args:["plan","close","<plan>","--test-cmd","<命令>"]})。';

const FAILURE_HINT = (toolName: string): string =>
  `[mint] tool ${toolName} failed — consider registering an issue: ` +
  `mint({args:["issue","add","<标题>","--kind","problem"]})\n`;

const BASH_TOOL_NAMES = new Set(['bash', 'tool:bash']);

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
 */
export const TODO_SYNC_REMINDER =
  '[mint] issue 状态已变更——同步宿主 todo：todo_write 全量重写清单，' +
  '让每项的 status 与 mint 一致（面板是人类看进度的入口）。';

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
