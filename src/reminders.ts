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
  if (result.isError || !isGitCommit(exec)) {
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
