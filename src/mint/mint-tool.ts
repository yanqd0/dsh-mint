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
 * `mint` 宿主工具。
 *
 * 为什么做宿主工具而不是 shell 出去：插件自己的子进程不受会话文件沙箱约束，所以 mint
 * 以**零授权**、零打断运行。模型得到覆盖整个 mint CLI 的一个稳定面，不必 bash 引号、
 * 不会撞沙箱拒绝，还自动带上会话的项目目录。
 *
 * 工具是**薄直通**：既不注入也不改写旗标，所以模型看到 mint 的原生输出（默认 TSV，`list`
 * 每页 5 行）。在这里加格式逻辑意味着每次 mint 输出变化（例如将来的 TOON 模式）都要重做
 * 一遍；直通 stdout 则面向未来。`--help` 经同一个工具到达模型，所以描述可以保持简短，
 * 不必内嵌小抄。
 */

export const TOOL_NAME = 'mint';

const MAX_OUTPUT_CHARS = 12_000;

/** 工具会执行的根子命令，按便于帮助的顺序排列。 */
export const ALLOWED_SUBCOMMANDS: readonly string[] = [
  'issue',
  'list',
  'show',
  'search',
  'label',
  'project',
  'plan',
  'milestone',
  // 只读健康检查：doctor 报警时注入的概览会把模型指向它，所以这个指针必须可执行。
  'doctor',
  'help',
];

/**
 * 不让模型碰的根子命令。每一条要么不可逆，要么是跨机器数据搬运，应当由人经 bash 显式驱动
 * （那里走常规审批流）。
 */
export const DENIED_SUBCOMMANDS: Readonly<Record<string, string>> = {
  delete: 'delete 是不可逆操作，请经用户确认后用 bash 执行',
  import: 'import 会合并外部快照，请经用户确认后用 bash 执行',
  sync: 'sync 是跨机数据同步，请经用户确认后用 bash 执行',
  export: 'export 会写出大文件，请经用户确认后用 bash 执行',
  tui: 'tui 是交互式界面，工具通道不适用',
};

/**
 * mint 没有子命令也处理的根级参数。两者都是纯输出、零副作用，所以工具放行：
 * `--help-llm` 一次调用载入整份 CLI 参考，省掉每个子命令一次 `--help` 往返；`-V` 报告运行
 * 中的版本。
 */
export const ALLOWED_ROOT_FLAGS: readonly string[] = ['-V', '--version', '--help-llm'];

/**
 * 会逃出会话项目语境或数据库的旗标。
 *
 * `--project` 已**不在**此列：跨项目目标是头等用例，写侧由 `cross-project.ts` 的确认门禁
 * 掌管。`--db` 继续拒绝——单文件数据库是另一桩信任决定，计划里明确把它排除在外。
 */
export const DENIED_FLAGS: readonly string[] = ['--db'];

/**
 * 面向模型的工具描述。
 *
 * 只讲**机制**（args 语义、输出形状、什么可用），别的都不讲：工具优先口径在
 * `MINT_TOOL_GUIDANCE`，流程在 `skill/SKILL.md`。这里的每个字节都随每个请求发出，所以示例
 * 就是全部小抄。
 *
 * 默认项目规则写在这里是有意的。`-p <项目>` 曾是并列示例，而只看到本描述的会话把它读成
 * 「像 `git -C` 那样显式点名项目」——身处 *mint 管理*项目里的会话于是给自己的项目加上了
 * `-p <自己>`。「默认取会话 cwd，所以本项目调用不带 `-p`」这条规则才是每个请求都必须看到的，
 * 而且比它取代的那个示例更省字节。
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
  /** mint 进程被墙钟上限杀掉。 */
  timedOut?: boolean;
  /**
   * 针对 argv 本身（而非 mint 的答案）的面向模型纠正，例如冗余的 `-p <本项目>`。单独一行
   * 渲染；必须在输出 schema 里声明，因为 `additionalProperties: false` 会让未声明的键致命
   * （`INVALID_TOOL_OUTPUT`）。
   */
  hint?: string;
}

/** `-p <本项目>` 调用的纠正行——它不需要 `-p`。 */
export function redundantProjectHint(project: string): string {
  return (
    `[mint] 提示：-p ${project} 就是本会话的项目，属冗余；` +
    '本项目操作不要带 -p（项目默认取会话 cwd）。'
  );
}

/**
 * clap 对运行中的构建不认识的子命令/旗标的措辞。它有两个来源，**先怀疑的是写法**：
 * ① 命令层级或参数个数写错（`search` 是**顶层**命令而不是 `issue search`；`attach` 只吃一个 id）；
 * ② 版本偏斜（实跑的 mint 落后于该命令）。判反了会把时间全花在换入口上，所以提示必须两支都给。
 */
const SKEW_ERROR_PATTERN = /unrecognized subcommand|unexpected argument|invalid subcommand/i;

/** 追加到 clap 不识别失败上的可行动后续：先排写法，再说版本偏斜。 */
export const MINT_SKEW_HINT =
  '提示：该子命令/参数不被当前 mint 识别。先排两种写法问题：① 命令层级（例如 `search` 是顶层命令，' +
  '不是 `issue search`）；② 参数个数/位置（有些子命令只吃一个 id）。用 mint({args:["--help-llm"]}) ' +
  '或该子命令的 --help 确认。两条都排除后才是版本偏斜（实跑的 mint 落后于该命令）：先用 mint({args:["-V"]}) ' +
  '确认版本；再用挂载行 mintEntry 或环境变量 MINT_ENTRY 指向更新的 mint' +
  '（如本地构建的 target/debug/mint）。';

/**
 * 被杀掉的 mint 进程的可行动后续。`mint-faa` 首次使用时懒下载二进制，而懒路径上什么都不
 * 打印，所以光秃秃的 `exit timeout` 读起来像 mint 坏了。进程首次运行现在有 180 s 预算，并发
 * 首跑已串行化；重试是最便宜的出路，两个覆写旋钮则应对确实很慢的链路。
 */
export const MINT_TIMEOUT_HINT =
  '提示：mint 进程被超时中断。全新安装后的首次调用需要先下载 mint 二进制（mint-faa 按需安装，无进度输出）——' +
  '首调预算已放宽且并发首调已串行化，直接重试通常即可；' +
  '若仍超时：用挂载行 mintEntry 或 MINT_ENTRY 指向已装好的 mint，' +
  '或先跑 node <插件>/dist/check-mint-entry.js --mode dependency 预热。';

/**
 * 拒绝工具不肯跑的 argv。返回模型可读的理由；argv 可接受时返回 `undefined`。
 *
 * `spawn` 收的是数组、从不是 shell，所以这里没有注入与引号面——这道检查管的是**范围**，
 * 不是转义。
 *
 * 全局旗标先由 {@link parseInvocation} 解析：`-p`/`--project` 是合法的前导旗标（形状、位置
 * 与取值都在那里校验），所以根子命令是 `rest[0]`，不是 `argv[0]`。
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
  // 旗标先判：被拒的全局旗标可能就坐在 argv[0]，否则会被误报成未知子命令。
  // `--db=<path>` 也算。
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
 * 为工具跑一次 mint 调用。
 *
 * mint 非零退出（用法错误、非法状态转移）是模型应当读取并从中恢复的*领域*结果，所以以
 * `ok: false` 返回而不是抛成工具错误；只有工具契约坏了才抛。
 *
 * 跨项目目标在 spawn **之前**先对 mint 的项目清单校验：`mint -p <错别字>` 否则会凭空创建
 * 一个 `abs_dir` 指向本会话工作区的项目数据库。确认门禁（`cross-project.ts`）先问用户；
 * 这道检查是到达执行的那些调用的工具侧兜底。
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
  // `-p <本项目>` 是显式点名下的默认路径。调用本身不动（薄直通），但答案带上纠正，好让
  // 模型别再写它——而且跨项目门禁不会发问。
  const ownHint =
    target !== undefined && isOwnProject(cwd, entry, target)
      ? redundantProjectHint(target)
      : undefined;
  const options: MintRunOptions = signal === undefined ? {} : { signal };
  if (entry !== undefined) {
    options.entry = entry;
  }
  const result = await runMint(cwd, argv as string[], options);
  // 能改变 `project list` 的调用不得留下过期答案：门禁、这次复查与 own-project 备忘都经
  // 那些备忘读取。
  if (result.ok && mutatesProjectList(invocation)) {
    resetProjectCache();
    resetOwnProjectCache();
  }
  if (result.ok) {
    // mint 即使成功也会往 stderr 写建议——`mint: hint: …` 行（去重合并建议、未合并机器
    // 告警）——所以照传。分页脚注不属于它们：自 mint 0.8 起它走 stdout（`# Page x/y`），
    // 已由逐字 stdout 路径携带。
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
 * 把一个工具结果渲染成面向模型的文本：stdout 逐字，随后是建议性的 stderr（mint 的
 * `mint: hint: …` 行，如去重或未合并机器告警），各占一行。
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
 * 在 `ctx.tools` 上注册 `mint` 工具。
 *
 * 注册在插件的根 context 上，即全局层，所以每个 agent 都继承它——包括进程内子代理，它们的
 * 审批策略被钉成 `never`，因此完全用不了 bash 路径（`notes/dsh/0.1.0/06,10,14`）。
 *
 * execute 处理器从工具执行里解析项目目录（`exec.agent.session.header.cwd`）并在那里直接
 * spawn mint。
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
          // 宿主会用这个 schema 校验每次成功返回值，而 `additionalProperties: false` 让
          // 未声明的键致命（`INVALID_TOOL_OUTPUT`，render 根本不会跑）。`timedOut` 是超时
          // 答案的一部分，必须在这里声明；`hint` 是冗余 `-p` 的纠正。
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
