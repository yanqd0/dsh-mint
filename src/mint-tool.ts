import { runMint } from './mint.js';
import type { ContentBlockLike, DshContext, ToolDefinitionLike, ToolExecutionLike } from './types.js';

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

/** Flags that would escape the session's project context or database. */
export const DENIED_FLAGS: readonly string[] = ['--db', '-p', '--project'];

export const MINT_TOOL_DESCRIPTION = [
  '在当前会话所属项目上运行 mint（issue/plan/milestone 三层管理）。命令在 DSH 宿主进程内执行：不经 bash、不受文件沙箱限制、无需任何授权。',
  '分层：issue 是基础条目；plan 对应一次开发计划（与 DSH plan 模式绑定）；milestone 对应项目功能版本。',
  '用法：args 是 mint CLI 参数数组（不含 `mint` 本身），原样透传。',
  '- 登记/查询：["issue","add",…]、["list","--status","open"]、["search","关键词"]',
  '- 流程推进：["issue","state","start","42"]、["issue","state","commit","42","--sha","abc1234"]、["plan","close","7","--test-cmd","pnpm test"]',
  '- 查详情：任意子命令加 --help，如 ["plan","--help"]',
  '输出是 mint 原生 TSV；list 默认每页 5 条（用 --page / --page-size / --no-page 调整）。不要用 bash 跑 mint。',
  '不可用：delete / import / sync / export / tui，以及 --db / --project（这些需用户显式操作）。',
].join('\n');

export interface MintToolArgs {
  args: string[];
}

export interface MintToolOutcome {
  ok: boolean;
  exitCode: number;
  stdout?: string;
  stderr?: string;
}

/**
 * Reject argv the tool refuses to run. Returns a model-readable reason, or
 * `undefined` when the argv is acceptable.
 *
 * `spawn` receives an array and never a shell, so there is no injection or
 * quoting surface here — this check is about *scope*, not about escaping.
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
  const [root] = argv as string[];
  if (root === undefined) {
    return 'args 不能为空：至少给出一个 mint 子命令（如 ["list"]）';
  }
  // Flags first: a denied global flag may sit in argv[0], where it would
  // otherwise be misreported as an unknown subcommand.
  const deniedFlag = (argv as string[]).find((token) => DENIED_FLAGS.includes(token));
  if (deniedFlag !== undefined) {
    return `不允许的参数：${deniedFlag}（项目上下文由会话 cwd 决定）`;
  }
  const denied = DENIED_SUBCOMMANDS[root];
  if (denied !== undefined) {
    return `不允许的子命令：${denied}`;
  }
  if (!ALLOWED_SUBCOMMANDS.includes(root)) {
    return `不支持的 mint 子命令：${root}（可用：${ALLOWED_SUBCOMMANDS.join(' ')}）`;
  }
  return undefined;
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
 */
export async function executeMintTool(
  cwd: string,
  argv: unknown,
  signal?: AbortSignal,
): Promise<MintToolOutcome> {
  const problem = validateMintArgs(argv);
  if (problem !== undefined) {
    return { ok: false, exitCode: 1, stderr: problem };
  }
  const result = await runMint(cwd, argv as string[], signal === undefined ? {} : { signal });
  if (result.ok) {
    return { ok: true, exitCode: 0, stdout: truncate(result.text ?? '') };
  }
  const exitCode = result.exitCode ?? (result.aborted === true ? 130 : 1);
  return { ok: false, exitCode, stderr: result.error ?? 'mint 执行失败' };
}

/** Render a tool outcome into model-facing text (stdout verbatim). */
export function renderMintOutcome(outcome: MintToolOutcome): string {
  if (outcome.ok) {
    const text = (outcome.stdout ?? '').trimEnd();
    return text.length > 0 ? text : '(mint 无输出)';
  }
  return `[mint] exit ${outcome.exitCode}: ${outcome.stderr ?? 'unknown error'}`;
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
export function installMintTool(ctx: DshContext): (() => void) | undefined {
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
        },
        required: ['ok', 'exitCode'],
        additionalProperties: false,
      },
      render: (_args, value) => [
        { type: 'text', text: renderMintOutcome(value as MintToolOutcome) } satisfies ContentBlockLike,
      ],
    },
    execute: async (rawArgs, exec: ToolExecutionLike) => {
      const cwd = exec?.agent?.session?.header?.cwd ?? process.cwd();
      const argv = (rawArgs as MintToolArgs | undefined)?.args;
      return executeMintTool(cwd, argv, exec?.signal);
    },
  };
  return tools.register(definition);
}
