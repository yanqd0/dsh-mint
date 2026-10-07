import {
  listProjects,
  missingProjectMessage,
  mutatesProjectList,
  parseInvocation,
  projectProbeFailureMessage,
  resetProjectCache,
} from './cross-project.js';
import { runMint } from './mint.js';
import type { MintRunOptions } from './mint.js';
import { isOwnProject, resetOwnProjectCache } from './own-project.js';
import type {
  ContentBlockLike,
  DshContext,
  ToolDefinitionLike,
  ToolExecutionLike,
} from '../shared/types.js';

/**
 * The `mint` host tool (#34).
 *
 * Why a host tool instead of shelling out: the plugin's own child processes are
 * not confined by the session file sandbox (#18), so mint runs with **zero
 * approvals** and zero interruptions. The model gets one stable surface for the
 * whole mint CLI without bash quoting, without sandbox denials, and with the
 * session's project directory filled in automatically.
 *
 * The tool is a **thin pass-through**: it neither injects nor rewrites flags, so
 * the model sees mint's native output (TSV by default, 5 rows per page for
 * `list`). Adding format logic here would have to be re-done for every mint
 * output change (e.g. a future TOON mode); passing stdout through is
 * future-proof. `--help` reaches the model through the same tool, so the
 * description stays short instead of embedding a cheat sheet.
 */

export const TOOL_NAME = 'mint';

const MAX_OUTPUT_CHARS = 12_000;

/** Root subcommands the tool will execute, in help-friendly order. */
export const ALLOWED_SUBCOMMANDS: readonly string[] = [
  'issue',
  'list',
  'show',
  'search',
  'label',
  'project',
  'plan',
  'milestone',
  // Read-only health check (#126): the injected overview points the model at it
  // when doctor reports warnings, so the pointer has to be executable.
  'doctor',
  'help',
];

/**
 * Root subcommands kept away from the model. Each is either irreversible or
 * cross-machine data movement that a human should drive explicitly through
 * bash (where the normal approval flow applies).
 */
export const DENIED_SUBCOMMANDS: Readonly<Record<string, string>> = {
  delete: 'delete 是不可逆操作，请经用户确认后用 bash 执行',
  import: 'import 会合并外部快照，请经用户确认后用 bash 执行',
  sync: 'sync 是跨机数据同步，请经用户确认后用 bash 执行',
  export: 'export 会写出大文件，请经用户确认后用 bash 执行',
  tui: 'tui 是交互式界面，工具通道不适用',
};

/**
 * Root-level flags that mint handles without a subcommand. Both are pure
 * output with zero side effects, so the tool passes them through (#57):
 * `--help-llm` loads the whole CLI reference in one call instead of one
 * `--help` round trip per subcommand, and `-V` reports the running version.
 */
export const ALLOWED_ROOT_FLAGS: readonly string[] = ['-V', '--version', '--help-llm'];

/**
 * Flags that would escape the session's project context or database.
 *
 * `--project` is **not** here any more (#55): a cross-project target is a
 * first-class use case, and the confirmation gate in `cross-project.ts` owns the
 * write side (#80). `--db` stays denied — a single-file database is a different
 * trust decision and the plan explicitly leaves it out.
 */
export const DENIED_FLAGS: readonly string[] = ['--db'];

/**
 * Model-facing tool description.
 *
 * Documents the **mechanism** (args semantics, output shape, what is available)
 * and nothing else: the tool-first policy lives in `MINT_TOOL_GUIDANCE` and the
 * workflow in `skill/SKILL.md` (#62). Every byte here ships on every request, so
 * the examples are the whole cheat sheet (#61).
 *
 * The default-project rule is stated here on purpose (#114). `-p <项目>` used to
 * be a co-equal example, and a session that saw only this description read it as
 * "name the project explicitly, like `git -C`" — sessions in *mint-managed*
 * projects then prefixed their **own** project with `-p <self>`. The rule
 * "default = session cwd, so own-project calls take no `-p`" is what every
 * request must see, and it costs less than the example it replaced.
 */
export const MINT_TOOL_DESCRIPTION = [
  '运行 mint（issue/plan/milestone 三层）；args 即 CLI 参数数组，插件进程内执行（零授权）。',
  '项目默认取会话 cwd：本项目操作不要带 -p；跨项目才加 ["-p","<项目>",…]（置于子命令前；写首次确认）。',
  '例：["list","--status","open"]、["issue","state","start","42"]。输出原生 TSV；list 每页 5 条（--page/--page-size/--no-page），末行 `# Page x/y` 页脚（stdout）给总数。参考 ["--help-llm"]，版本 ["-V"]。',
  '不可用：delete/import/sync/export/tui、--db。',
].join('\n');

export interface MintToolArgs {
  args: string[];
}

export interface MintToolOutcome {
  ok: boolean;
  exitCode: number;
  stdout?: string;
  stderr?: string;
  /** The mint process was killed by the wall-clock limit (#45). */
  timedOut?: boolean;
  /**
   * Model-facing correction for the argv itself (not for mint's answer), e.g.
   * a redundant `-p <本项目>` (#114). Rendered on its own line; declared in the
   * output schema because `additionalProperties: false` makes an undeclared key
   * fatal (`INVALID_TOOL_OUTPUT`, #100).
   */
  hint?: string;
}

/** Corrective line for a `-p <本项目>` call, which needs no `-p` (#114). */
export function redundantProjectHint(project: string): string {
  return (
    `[mint] 提示：-p ${project} 就是本会话的项目，属冗余；` +
    '本项目操作不要带 -p（项目默认取会话 cwd）。'
  );
}

/**
 * clap wording for a subcommand/flag the running build does not know. Version
 * skew still happens with a local/older entry (or a CLI that dropped a flag), so
 * it comes back as `unexpected argument` — a version problem that reads like a
 * typo unless it is called out (#58).
 */
const SKEW_ERROR_PATTERN = /unrecognized subcommand|unexpected argument|invalid subcommand/i;

/** Actionable follow-up appended to a version-skew failure (#58). */
export const MINT_SKEW_HINT =
  '提示：该子命令/参数不被当前 mint 识别，可能是版本偏斜（实跑的 mint 落后于该命令）。' +
  '先用 mint({args:["-V"]}) 确认版本；再用挂载行 mintEntry 或环境变量 MINT_ENTRY 指向更新的 mint' +
  '（如本地构建的 target/debug/mint）。';

/**
 * Actionable follow-up for a killed mint process (#45). `mint-faa` downloads the
 * binary lazily on first use, and that download prints nothing on the lazy path,
 * so a bare `exit timeout` reads like a broken mint. The first run of a process
 * now gets a 180 s budget and concurrent first runs are serialized; a retry is
 * the cheapest way out, and the two overrides cover a genuinely slow link.
 */
export const MINT_TIMEOUT_HINT =
  '提示：mint 进程被超时中断。全新安装后的首次调用需要先下载 mint 二进制（mint-faa 按需安装，无进度输出）——' +
  '首调预算已放宽且并发首调已串行化，直接重试通常即可；' +
  '若仍超时：用挂载行 mintEntry 或 MINT_ENTRY 指向已装好的 mint，' +
  '或先跑 node <插件>/dist/check-mint-entry.js --mode dependency 预热。';

/**
 * Reject argv the tool refuses to run. Returns a model-readable reason, or
 * `undefined` when the argv is acceptable.
 *
 * `spawn` receives an array and never a shell, so there is no injection or
 * quoting surface here — this check is about *scope*, not about escaping.
 *
 * Global flags are resolved by {@link parseInvocation} first: `-p`/`--project`
 * is a legal leading flag (its shape, position and value are validated there),
 * so the root subcommand is `rest[0]`, not `argv[0]` (#55).
 */
export function validateMintArgs(argv: unknown): string | undefined {
  if (!Array.isArray(argv) || argv.length === 0) {
    return 'args 不能为空：至少给出一个 mint 子命令（如 ["list"]）';
  }
  for (const token of argv) {
    if (typeof token !== 'string' || token.length === 0) {
      return 'args 只能是非空字符串数组';
    }
    if (token.includes('\0')) {
      return 'args 不能包含空字符';
    }
  }
  const tokens = argv as string[];
  // Flags first: a denied global flag may sit in argv[0], where it would
  // otherwise be misreported as an unknown subcommand. `--db=<path>` counts too.
  const deniedFlag = tokens.find((token) =>
    DENIED_FLAGS.some((flag) => token === flag || token.startsWith(`${flag}=`))
  );
  if (deniedFlag !== undefined) {
    return `不允许的参数：${deniedFlag}（项目上下文由会话 cwd 决定；跨项目请用 --project）`;
  }
  const invocation = parseInvocation(tokens);
  if (invocation.problem !== undefined) {
    return invocation.problem;
  }
  const root = invocation.rest[0];
  if (root === undefined) {
    if (invocation.rootFlag !== undefined && ALLOWED_ROOT_FLAGS.includes(invocation.rootFlag)) {
      return undefined;
    }
    return 'args 需要至少一个 mint 子命令（如 ["-p","<项目>","list"]）';
  }
  const denied = DENIED_SUBCOMMANDS[root];
  if (denied !== undefined) {
    return `不允许的子命令：${denied}`;
  }
  if (ALLOWED_SUBCOMMANDS.includes(root) || ALLOWED_ROOT_FLAGS.includes(root)) {
    return undefined;
  }
  if (root.startsWith('-')) {
    return `不支持的 mint 顶层参数：${root}（可用：${ALLOWED_ROOT_FLAGS.join(' ')}）`;
  }
  return `不支持的 mint 子命令：${root}（可用：${ALLOWED_SUBCOMMANDS.join(' ')}）`;
}

function truncate(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) {
    return text;
  }
  return `${text.slice(0, MAX_OUTPUT_CHARS)}\n…[输出已截断，原始 ${text.length} 字符]`;
}

/**
 * Run one mint invocation for the tool.
 *
 * A nonzero mint exit (usage error, invalid state transition) is a *domain*
 * result the model should read and recover from, so it comes back as
 * `ok: false` rather than a thrown tool error; only a broken tool contract
 * throws.
 *
 * A cross-project target is resolved against mint's project list **before**
 * spawning (#80): `mint -p <typo>` would otherwise create a phantom project
 * database whose `abs_dir` is this session's workspace. The confirmation gate
 * (`cross-project.ts`) asks the user first; this check is the tool-side
 * backstop for the calls that reach execution.
 */
export async function executeMintTool(
  cwd: string,
  argv: unknown,
  signal?: AbortSignal,
  entry?: string
): Promise<MintToolOutcome> {
  const problem = validateMintArgs(argv);
  if (problem !== undefined) {
    return { ok: false, exitCode: 1, stderr: problem };
  }
  const invocation = parseInvocation(argv as string[]);
  const target = invocation.project;
  if (target !== undefined) {
    const candidates = await listProjects(cwd, entry);
    if (candidates === undefined) {
      return { ok: false, exitCode: 1, stderr: projectProbeFailureMessage(target) };
    }
    if (!candidates.includes(target)) {
      return { ok: false, exitCode: 1, stderr: missingProjectMessage(target, candidates) };
    }
  }
  // `-p <本项目>` is the default path under an explicit name. The call is left
  // untouched (thin pass-through), but the answer carries the correction so the
  // model stops writing it — and the cross-project gate does not ask (#114).
  const ownHint =
    target !== undefined && isOwnProject(cwd, entry, target)
      ? redundantProjectHint(target)
      : undefined;
  const options: MintRunOptions = signal === undefined ? {} : { signal };
  if (entry !== undefined) {
    options.entry = entry;
  }
  const result = await runMint(cwd, argv as string[], options);
  // A call that can change `project list` must not leave a stale answer behind:
  // the gate, this re-check and the own-project memo all read through those
  // memos (#106, #114).
  if (result.ok && mutatesProjectList(invocation)) {
    resetProjectCache();
    resetOwnProjectCache();
  }
  if (result.ok) {
    // mint writes advisories to stderr even on success — `mint: hint: …` lines
    // (dedup merge suggestion, unmerged-machine warning) — so they are passed
    // through. The paging footer is not one of them: since mint 0.8 it goes to
    // stdout (`# Page x/y`), which the verbatim stdout path already carries.
    // (#56, corrected #78.)
    const outcome: MintToolOutcome = {
      ok: true,
      exitCode: 0,
      stdout: truncate(result.text ?? ''),
    };
    const advisory = (result.stderr ?? '').trim();
    if (advisory.length > 0) {
      outcome.stderr = truncate(advisory);
    }
    if (ownHint !== undefined) outcome.hint = ownHint;
    return outcome;
  }
  const exitCode = result.exitCode ?? (result.aborted === true ? 130 : 1);
  const failed: MintToolOutcome = { ok: false, exitCode, stderr: result.error ?? 'mint 执行失败' };
  if (result.timedOut === true) failed.timedOut = true;
  if (ownHint !== undefined) failed.hint = ownHint;
  return failed;
}

/**
 * Render a tool outcome into model-facing text: stdout verbatim, then any
 * advisory stderr (mint's `mint: hint: …` lines, e.g. dedup or
 * unmerged-machine warnings) on its own line.
 */
export function renderMintOutcome(outcome: MintToolOutcome): string {
  if (outcome.ok) {
    const parts = [outcome.stdout ?? '', outcome.stderr ?? '', outcome.hint ?? '']
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    return parts.length > 0 ? parts.join('\n') : '(mint 无输出)';
  }
  const lines = [`[mint] exit ${outcome.exitCode}: ${outcome.stderr ?? 'unknown error'}`];
  if (outcome.hint !== undefined) lines.push(outcome.hint);
  if (outcome.timedOut === true) lines.push(MINT_TIMEOUT_HINT);
  if (SKEW_ERROR_PATTERN.test(outcome.stderr ?? '')) lines.push(MINT_SKEW_HINT);
  return lines.join('\n');
}

/**
 * Register the `mint` tool on `ctx.tools`.
 *
 * Registered on the plugin's root context, i.e. the global layer, so every
 * agent inherits it — including in-process subagents, whose approval policy is
 * pinned to `never` and which therefore cannot use the bash path at all
 * (`notes/dsh/0.1.0/06,10,14`).
 *
 * The execute handler resolves the project directory from the tool execution
 * (`exec.agent.session.header.cwd`) and spawns mint there directly.
 */
export function installMintTool(ctx: DshContext, entry?: string): (() => void) | undefined {
  const tools = ctx.tools;
  if (!tools) {
    return undefined;
  }
  const definition: ToolDefinitionLike = {
    name: TOOL_NAME,
    description: MINT_TOOL_DESCRIPTION,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        args: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          description:
            'mint CLI 参数数组（不含 `mint` 本身），如 ["issue","state","start","42"]；任意子命令加 --help 查详情',
        },
      },
      required: ['args'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          exitCode: { type: 'integer' },
          stdout: { type: 'string' },
          stderr: { type: 'string' },
          // The host validates this schema against every successful return value
          // and `additionalProperties: false` makes an undeclared key fatal
          // (`INVALID_TOOL_OUTPUT`, render never runs). `timedOut` is part of the
          // timeout answer, so it must be declared here (#100); `hint` is the
          // redundant-`-p` correction (#114).
          timedOut: { type: 'boolean' },
          hint: { type: 'string' },
        },
        required: ['ok', 'exitCode'],
        additionalProperties: false,
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: renderMintOutcome(value as MintToolOutcome),
        } satisfies ContentBlockLike,
      ],
    },
    execute: async (rawArgs, exec: ToolExecutionLike) => {
      const cwd = exec?.agent?.session?.header?.cwd ?? process.cwd();
      const argv = (rawArgs as MintToolArgs | undefined)?.args;
      return executeMintTool(cwd, argv, exec?.signal, entry);
    },
  };
  return tools.register(definition);
}
