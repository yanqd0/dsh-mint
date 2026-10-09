import { runMint } from './mint.js';
import type { MintRunOptions } from './mint.js';
import { isRecord } from './mint-json.js';
import { hasControlCharacter, isControlChar } from '../shared/text.js';

/**
 * 跨项目 mint 调用：`--project` 解析、读/写分类与存在性探测。
 *
 * `mint -p <name>` 对未知名字不是「失败」——它**创建**该项目
 * （`projects/<name>/<machine_id>.db`），并登记一行 `abs_dir` 指向*会话 cwd*（上游
 * `src/cli/run.rs`、`src/db/mod.rs`、`src/project.rs`）。所以一个错别字会落成指向本仓库的
 * 幽灵项目，工具因此在 spawn 任何东西**之前**先对真实项目清单校验目标。
 *
 * 这里的一切都是 mint 自己旗标之上的薄、可测层：没有格式逻辑（mint 的 TSV/JSON 逐字通过），
 * 也没有除 `project list --json` 之外的数据访问，而后者是目录扫描、无数据库副作用
 * （`project list` 的 `needs_conn = false`）。
 */

/** 本模块发问的审批理由的受审前缀。 */
export const CROSS_PROJECT_REASON_PREFIX = 'cross-project write → project ';

/** 一条可行动错误最多携带多少个候选项目名。 */
const MAX_CANDIDATES = 20;

/** 审批提示里模型提供的 argv 渲染上限。 */
const MAX_ACTION_CHARS = 160;

/** mint 在子命令之前接受的无值全局旗标。 */
const VALUE_LESS_GLOBAL_FLAGS: readonly string[] = [
  '--help-llm',
  '-V',
  '--version',
  '-h',
  '--help',
];

/** `issue`/`plan`/`milestone` 里只读的子名。 */
const READ_LEAVES: ReadonlySet<string> = new Set(['list', 'show', 'get']);

/** 子名按 `READ_LEAVES` 分读/写的根。 */
const CONTAINER_ROOTS: ReadonlySet<string> = new Set(['issue', 'plan', 'milestone']);

/** `mint label` 的子名。 */
const LABEL_READ_LEAVES: ReadonlySet<string> = new Set(['list']);

/** `mint project <leaf>` 里从不碰既有项目台账的。 */
const PROJECT_LEDGER_EXEMPT: ReadonlySet<string> = new Set(['create']);

/**
 * 本层拒绝解释的 shell 形状（引号、展开、重定向、通配）。`~` 刻意不在其中：
 * `cd ~/repo && mint …` 正是这条通道存在的理由，而这里什么都不展开路径。
 */
const UNSAFE_SHELL = /["'`\\$(){}<>*?!#]/;

/** 一段 `NAME=value` 形式的 shell 赋值前缀。 */
const SHELL_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** 就是 mint 自己的命令词（`mint`、`/home/u/bin/mint`…）。 */
const MINT_COMMAND_WORD = /(^|[/\\])mint$/;

/** mint CLI 的项目环境变量。 */
const PROJECT_ENV = 'MINT_PROJECT';

/** mint CLI 的单文件覆写；会禁用项目选择。 */
const DB_ENV = 'MINT_DB_PATH';

export interface Invocation {
  /** 交给工具的 argv，未改动。 */
  readonly argv: readonly string[];
  /** argv 去掉前导全局旗标：`[<subcommand>, …]`。 */
  readonly rest: readonly string[];
  /**
   * 显式目标项目（`-p`/`--project` 的值，否则 `MINT_PROJECT`）。缺失表示「会话自己的项目」
   * （默认）。
   */
  readonly project?: string;
  /** {@link Invocation.project} 的来源。 */
  readonly projectSource?: 'flag' | 'env';
  /** 单独出现的无值全局旗标（`mint -V`）。 */
  readonly rootFlag?: string;
  /** 不可接受的 argv 及其模型可读理由；按原样拒绝该调用。 */
  readonly problem?: string;
}

/** {@link Invocation} 在 {@link parseInvocation} 里被逐段构建时的形态。 */
type MutableInvocation = { -readonly [K in keyof Invocation]: Invocation[K] };

/**
 * mint 的 `validate_project_name` 的镜像（去空白后为空、`.`/`..`、路径分隔符、控制字符）。
 * mint 校验的是去空白后的值，却用原值拼路径，所以要查的是原值。
 */
export function projectNameProblem(name: string): string | undefined {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    return '项目名不能为空：形如 ["-p","<项目>", …]';
  }
  if (trimmed === '.' || trimmed === '..') {
    return `项目名非法：'${trimmed}'`;
  }
  if (name.includes('/') || name.includes('\\') || hasControlCharacter(name)) {
    return `项目名不能包含路径分隔符或控制字符（--project 只接受项目名，不是路径）：'${name}'`;
  }
  return undefined;
}

/**
 * 把 argv 拆成前导全局旗标与子命令调用，顺路取出目标项目。
 *
 * `-p`/`--project` 上游**不是** clap 全局旗标，所以它只在子命令之前才算数：
 * `mint list --project x` 是用法错误。子命令之后出现的旗标（或重复）被报成 problem 而不是
 * 放行——CLI 反正会以 2 退出，而一条清楚的理由胜过一次无谓的审批提示。
 */
export function parseInvocation(
  argv: readonly string[],
  envProject: string | undefined = process.env[PROJECT_ENV]
): Invocation {
  const tokens = [...argv];
  const leading: string[] = [];
  let project: string | undefined;
  let projectSource: 'flag' | 'env' | undefined;
  let rootFlag: string | undefined;
  let problem: string | undefined;

  const setProject = (value: string | undefined): void => {
    if (project !== undefined) {
      problem ??= 'mint 不接受重复的 --project：只指定一个目标项目';
      return;
    }
    if (value === undefined) {
      problem ??= '--project 缺少项目名：形如 ["-p","<项目>", …]';
      return;
    }
    project = value;
    projectSource = 'flag';
  };

  let index = 0;
  for (; index < tokens.length; index += 1) {
    const token = tokens[index] ?? '';
    if (token === '--') {
      index += 1;
      break;
    }
    if (token === '-p' || token === '--project') {
      leading.push(token);
      index += 1;
      setProject(tokens[index]);
      continue;
    }
    if (token.startsWith('--project=')) {
      leading.push(token);
      setProject(token.slice('--project='.length));
      continue;
    }
    if (token.startsWith('-p') && token.length > 2) {
      leading.push(token);
      const attached = token.slice(2);
      setProject(attached.startsWith('=') ? attached.slice(1) : attached);
      continue;
    }
    if (token === '--db') {
      // 工具在这之前就拒了；这里消费掉它，好让扫描保持对齐。
      leading.push(token);
      index += 1;
      const value = tokens[index];
      if (value !== undefined) leading.push(value);
      continue;
    }
    if (token.startsWith('--db=')) {
      leading.push(token);
      continue;
    }
    if (VALUE_LESS_GLOBAL_FLAGS.includes(token)) {
      leading.push(token);
      rootFlag ??= token;
      continue;
    }
    break;
  }

  const rest = tokens.slice(index);
  const bare = rest.indexOf('--');
  const scanned = bare === -1 ? rest : rest.slice(0, bare);
  if (scanned.some((token) => isProjectFlagToken(token))) {
    problem ??=
      '--project 必须放在子命令之前（clap 顶层参数）：如 ["-p","dsh-dev-dsh","list"]，' +
      '而不是 ["list","--project","dsh-dev-dsh"]';
  }

  if (project === undefined && problem === undefined) {
    const fromEnv = envProject?.trim();
    if (fromEnv !== undefined && fromEnv.length > 0) {
      project = fromEnv;
      projectSource = 'env';
    }
  }

  if (project !== undefined) {
    const dbOverride = process.env[DB_ENV]?.trim();
    if (dbOverride !== undefined && dbOverride.length > 0) {
      problem ??=
        `${DB_ENV} 单文件模式不支持跨项目：--project 只改项目名标签、不选库，` +
        '请改用多项目库（去掉 MINT_DB_PATH）';
    }
    problem ??= projectNameProblem(project);
  }

  const result: MutableInvocation = { argv: [...argv], rest };
  if (project !== undefined) {
    result.project = project;
    if (projectSource !== undefined) result.projectSource = projectSource;
  }
  if (rootFlag !== undefined) result.rootFlag = rootFlag;
  if (problem !== undefined) result.problem = problem;
  return result;
}

/** 一个 token 是否以任何被接受的拼法点出 project 旗标。 */
function isProjectFlagToken(token: string): boolean {
  return (
    token === '-p' ||
    token === '--project' ||
    token.startsWith('--project=') ||
    (token.startsWith('-p') && token.length > 2)
  );
}

/**
 * 该调用是否能**写**目标台账。读是一份显式白名单（mint 自己的只读子名）；任何不认识的都算
 * 写，于是新增的 mint 子命令无法溜过门禁。
 *
 * 取整个 {@link Invocation} 而非它的 `rest`，因为空的 `rest` 不是写：`parseInvocation` 把
 * 每个无值全局旗标（`-V`、`--version`、`--help*`）都挪进了 `leading`，所以 `rest` 为空恰好
 * 说明调用方要的是 CLI 的版本/帮助——或者什么都没要，那是用法错误（退出 2）、不碰台账。把
 * 两者任一归类成写，就是让用户去确认真空上的纯读，而子代理（审批钉成 `never`）根本跑不了。
 *
 * `rest` **内部**的 help token 从不降级该调用：前导扫描已经取走根级那些，剩下的都是子命令的
 * 参数、可能是某个取值——`issue add -- --help` 会创建一条标题为 `--help` 的 issue。这样的调用
 * 仍是写。
 */
export function isWriteInvocation(invocation: Invocation): boolean {
  const { rest } = invocation;
  const root = rest[0];
  const leaf = rest[1];
  if (root === undefined) return false;
  if (root === 'list' || root === 'show' || root === 'search') return false;
  // `doctor` 是只读健康检查：不碰任何台账，所以跨项目的 `-p <other> doctor` 不需要确认。
  if (root === 'doctor') return false;
  if (root === 'help') return false;
  if (CONTAINER_ROOTS.has(root)) {
    return leaf === undefined ? true : !READ_LEAVES.has(leaf);
  }
  if (root === 'label') return leaf === undefined ? true : !LABEL_READ_LEAVES.has(leaf);
  if (root === 'project') {
    if (leaf !== undefined && PROJECT_LEDGER_EXEMPT.has(leaf)) return false;
    return leaf === undefined ? true : !READ_LEAVES.has(leaf);
  }
  return true;
}

/**
 * 抽出一条**简单** shell 命令（bash 通道）里的 mint 调用。只返回本层读得懂的 token 的命令：
 * 引号、替换、重定向与通配会让命令在这里无法解释，而它读不懂的 shell 形状保持既有行为
 * （沙箱提权审批仍由人决定）。内联的 `MINT_PROJECT=…` 赋值被采信，因为 CLI 采信它。
 */
export function parseBashMintCalls(command: unknown): readonly Invocation[] {
  if (typeof command !== 'string' || UNSAFE_SHELL.test(command)) return [];
  const invocations: Invocation[] = [];
  for (const rawSegment of command.split(/&&|\|\||;|\n|\|/)) {
    const segment = rawSegment.trim();
    if (segment.length === 0) continue;
    const tokens = segment.split(/[ \t]+/);
    let index = 0;
    let inlineProject: string | undefined;
    while (index < tokens.length && SHELL_ASSIGNMENT.test(tokens[index] ?? '')) {
      const token = tokens[index] ?? '';
      const name = token.slice(0, token.indexOf('='));
      if (name === PROJECT_ENV) inlineProject = token.slice(token.indexOf('=') + 1);
      index += 1;
    }
    const commandWord = tokens[index];
    if (commandWord === undefined || !MINT_COMMAND_WORD.test(commandWord)) continue;
    const invocation = parseInvocation(
      tokens.slice(index + 1),
      inlineProject ?? process.env[PROJECT_ENV]
    );
    invocations.push(invocation);
  }
  return invocations;
}

/**
 * 一条调用的面向模型动作摘要：全局旗标之后的全部内容，剥掉控制字符并限长，好让模型提供的
 * argv 无法重塑审批提示。
 */
export function renderAction(rest: readonly string[]): string {
  const cleaned = rest
    .map((token) => [...token].filter((char) => !isControlChar(char)).join(''))
    .join(' ');
  return cleaned.length <= MAX_ACTION_CHARS ? cleaned : `${cleaned.slice(0, MAX_ACTION_CHARS)}…`;
}

/** 一次跨项目写的受审理由 + 本地化提示文案。 */
export function buildApprovalText(
  project: string,
  rest: readonly string[]
): { reason: string; displayReason: { en: string; zh: string } } {
  const action = renderAction(rest);
  return {
    reason: `${CROSS_PROJECT_REASON_PREFIX}"${project}": mint ${action}`,
    displayReason: {
      en: `mint will write to another project's ledger: ${action} (target project: ${project}). Allow?`,
      zh: `将对别的项目台账执行写操作：${action}（目标项目：${project}）。是否允许？`,
    },
  };
}

/**
 * 从本模块构造的审批理由里还原目标项目。名字紧跟在前缀之后、不可能跨过 `"`；任何非预期形状都
 * 返回 `undefined`，那表示「本会话没有授权」——下一次写会再问。
 */
export function projectFromReason(reason: unknown): string | undefined {
  if (typeof reason !== 'string' || !reason.startsWith(CROSS_PROJECT_REASON_PREFIX))
    return undefined;
  const head = reason.slice(CROSS_PROJECT_REASON_PREFIX.length);
  if (!head.startsWith('"')) return undefined;
  const end = head.indexOf('": ', 1);
  if (end <= 1) return undefined;
  return head.slice(1, end);
}

/** 目标不是本机项目的可行动错误。 */
export function missingProjectMessage(project: string, candidates: readonly string[]): string {
  const shown = candidates.slice(0, MAX_CANDIDATES).join(', ');
  return (
    `目标项目 "${project}" 不存在：--project 只接受 mint 数据目录下 projects/ 里的项目名` +
    '（不是路径），且必须放在子命令之前。\n' +
    `候选（${candidates.length}）：${shown.length > 0 ? shown : '（无）'}；` +
    '全量用 mint({args:["project","list"]})。\n' +
    `新建项目：mint({args:["project","create","${project}"]})。单文件模式（MINT_DB_PATH）不支持跨项目。`
  );
}

/** 项目清单本身读不出来时的可行动错误。 */
export function projectProbeFailureMessage(project: string): string {
  return (
    `无法校验目标项目 "${project}"：mint 的 project list 执行失败。` +
    '跨项目操作要求可用的 mint 与项目清单，已按 fail-closed 拒绝本次调用。'
  );
}

/**
 * mint 知道的那些项目名（`project list --json`）。
 *
 * 任何失败都返回 `undefined`——调用方失败关闭。该命令只扫数据目录、不开数据库
 * （`needs_conn = false`），所以这个探测对目标项目没有副作用。
 *
 * 一次跨项目工具调用按设计探测**两次**——门禁在执行前决定、工具在 spawn 前复查——所以成功
 * 答案会按 {@link PROJECT_LIST_TTL_MS} 记住，两个调用方共用一个子进程。只备忘成功的读：失败
 * 仍意味着「失败关闭」，而不在备忘答案里的名字仍被拒。这个窗口刻意很短：探测本质上是
 * time-of-check/time-of-use 的答案，所以缓存不会把间隙拉宽到超过一次刷新。
 */
export async function listProjects(
  cwd: string,
  entry?: string
): Promise<readonly string[] | undefined> {
  const key = projectCacheKey(cwd, entry);
  const cached = projectListCache.get(key);
  if (cached !== undefined && Date.now() - cached.at < PROJECT_LIST_TTL_MS) {
    return cached.names;
  }
  const options: MintRunOptions = entry === undefined ? {} : { entry };
  const result = await runMint(cwd, ['project', 'list', '--json'], options);
  if (!result.ok) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.text ?? '');
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  const names = parsed.map((item) =>
    isRecord(item) && typeof item.name === 'string' ? item.name : undefined
  );
  if (names.some((name) => name === undefined)) return undefined;
  projectListCache.set(key, { at: Date.now(), names: names as string[] });
  return names as string[];
}

/** 一次成功的项目清单读给两个调用方用多久。 */
export const PROJECT_LIST_TTL_MS = 5_000;

/** 探测的答案，按 (cwd, entry) 记住 {@link PROJECT_LIST_TTL_MS}。 */
const projectListCache = new Map<string, { at: number; names: readonly string[] }>();

/**
 * 忘掉已备忘的项目清单。
 *
 * 两个调用方：测试（状态不得跨用例泄漏）与工具——在一次可能改变答案的调用之后（否则
 * `project create` / `project set` 会在长达 TTL 的时间里不可见）。
 */
export function resetProjectCache(): void {
  projectListCache.clear();
}

/** 缓存键：cwd 与 entry 共同决定探测看到什么。 */
export function projectCacheKey(cwd: string, entry: string | undefined): string {
  return `${entry ?? ''}\u0000${cwd}`;
}

/** 该调用是否能改变 `project list` 的答案。 */
export function mutatesProjectList(invocation: Invocation): boolean {
  const [root, leaf] = invocation.rest;
  return root === 'project' && (leaf === 'create' || leaf === 'set');
}
