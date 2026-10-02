import { runMint } from './mint.js';
import type { MintRunOptions } from './mint.js';
import { isRecord } from './mint-json.js';

/**
 * Cross-project mint calls: `--project` parsing, read/write classification and
 * the existence probe (#55, #80).
 *
 * `mint -p <name>` does not "fail" for an unknown name — it **creates** the
 * project (`projects/<name>/<machine_id>.db`) and registers a row whose
 * `abs_dir` is the *session cwd* (`src/cli/run.rs`, `src/db/mod.rs`,
 * `src/project.rs` upstream). A typo therefore lands as a phantom project
 * pointing at this repository, so the tool resolves the target against the real
 * project list **before** spawning anything (#80).
 *
 * Everything here is a thin, testable layer over mint's own flags: no format
 * logic (mint's TSV/JSON goes through verbatim) and no data access other than
 * `project list --json`, which is a directory scan with no database side effect
 * (`needs_conn = false` for `project list`).
 */

/** Audited-prefix of the approval reason this module asks with (#80). */
export const CROSS_PROJECT_REASON_PREFIX = 'cross-project write → project ';

/** How many candidate project names an actionable error may carry. */
const MAX_CANDIDATES = 20;

/** Model-supplied argv rendering bound in the approval prompt. */
const MAX_ACTION_CHARS = 160;

/** Value-less global flags mint accepts before the subcommand. */
const VALUE_LESS_GLOBAL_FLAGS: readonly string[] = [
  '--help-llm',
  '-V',
  '--version',
  '-h',
  '--help',
];

/** Sub-name position of `issue`/`plan`/`milestone` that only reads. */
const READ_LEAVES: ReadonlySet<string> = new Set(['list', 'show', 'get']);

/** Roots whose leaves are split into read/write by `READ_LEAVES`. */
const CONTAINER_ROOTS: ReadonlySet<string> = new Set(['issue', 'plan', 'milestone']);

/** `mint label` leaves. */
const LABEL_READ_LEAVES: ReadonlySet<string> = new Set(['list']);

/** `mint project <leaf>` that never touches an existing project ledger. */
const PROJECT_LEDGER_EXEMPT: ReadonlySet<string> = new Set(['create']);

/**
 * Shell shapes this layer refuses to interpret (quotes, expansions, redirects,
 * globbing). `~` is deliberately absent: `cd ~/repo && mint …` is the idiom this
 * channel exists for, and nothing here expands paths.
 */
const UNSAFE_SHELL = /["'`\\$(){}<>*?!#]/;

/** One `NAME=value` shell assignment prefix. */
const SHELL_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** A command word that is mint itself (`mint`, `/home/u/bin/mint`, …). */
const MINT_COMMAND_WORD = /(^|[/\\])mint$/;

/** The mint CLI's project environment variable. */
const PROJECT_ENV = 'MINT_PROJECT';

/** The mint CLI's single-file override; disables project selection. */
const DB_ENV = 'MINT_DB_PATH';

export interface Invocation {
  /** The argv as handed to the tool, unchanged. */
  readonly argv: readonly string[];
  /** argv minus the leading global flags: `[<subcommand>, …]`. */
  readonly rest: readonly string[];
  /**
   * Explicit target project (a `-p`/`--project` value, else `MINT_PROJECT`).
   * Absent means "the session's own project" — the pre-#55 behaviour.
   */
  readonly project?: string;
  /** Where {@link Invocation.project} came from. */
  readonly projectSource?: 'flag' | 'env';
  /** A value-less global flag standing alone (`mint -V`). */
  readonly rootFlag?: string;
  /** Unacceptable argv with a model-readable reason; refuses the call as-is. */
  readonly problem?: string;
}

/** {@link Invocation} as built incrementally by {@link parseInvocation}. */
type MutableInvocation = { -readonly [K in keyof Invocation]: Invocation[K] };

function isControlChar(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return code < 0x20 || code === 0x7f;
}

/**
 * Mirror of mint's `validate_project_name` (trimmed emptiness, `.`/`..`, path
 * separators, control characters). mint validates the trimmed value but builds
 * the path from the raw one, so the raw value is what gets looked up.
 */
export function projectNameProblem(name: string): string | undefined {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    return '项目名不能为空：形如 ["-p","<项目>", …]';
  }
  if (trimmed === '.' || trimmed === '..') {
    return `项目名非法：'${trimmed}'`;
  }
  if ([...name].some((char) => char === '/' || char === '\\' || isControlChar(char))) {
    return `项目名不能包含路径分隔符或控制字符（--project 只接受项目名，不是路径）：'${name}'`;
  }
  return undefined;
}

/**
 * Split argv into leading global flags and the subcommand invocation, pulling
 * out the target project on the way.
 *
 * `-p`/`--project` is **not** a clap global flag upstream, so it only counts
 * before the subcommand: `mint list --project x` is a usage error. A flag found
 * after the subcommand (or a duplicate) is reported as a problem instead of
 * being passed on — the CLI would exit 2 anyway, and a clear reason beats a
 * pointless approval prompt.
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
      // Denied by the tool before this runs; consumed so scanning stays aligned.
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

/** True for a token that names the project flag in any accepted spelling. */
function isProjectFlagToken(token: string): boolean {
  return (
    token === '-p' ||
    token === '--project' ||
    token.startsWith('--project=') ||
    (token.startsWith('-p') && token.length > 2)
  );
}

/**
 * True when the invocation can **write** to the target ledger. Reads are an
 * explicit allowlist (mint's own read leaves); anything unrecognised counts as
 * a write, so a new mint subcommand cannot slip past the gate.
 *
 * The whole {@link Invocation} is taken rather than its `rest`, because an empty
 * `rest` is not a write: `parseInvocation` moves every value-less global flag
 * (`-V`, `--version`, `--help*`) into `leading`, so `rest` is empty exactly when
 * the caller asked for the CLI's version/help — or for nothing at all, which is
 * a usage error (exit 2) that touches no ledger. Classifying either as a write
 * asked the user to confirm a pure read, and a subagent (approvals pinned to
 * `never`) could not run it at all (#99).
 *
 * A help token **inside** `rest` never downgrades the call: the leading scan has
 * already taken the root-level ones, so anything left is an argument of the
 * subcommand and may be a value — `issue add -- --help` creates an issue titled
 * `--help` (#98). Such a call stays a write.
 */
export function isWriteInvocation(invocation: Invocation): boolean {
  const { rest } = invocation;
  const root = rest[0];
  const leaf = rest[1];
  if (root === undefined) return false;
  if (root === 'list' || root === 'show' || root === 'search') return false;
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
 * Extract the mint invocations of a **simple** shell command (#80, bash
 * channel). Only commands whose tokens this layer can read are returned:
 * quotes, substitutions, redirects and globbing make a command uninterpretable
 * here, and shell shapes it cannot read keep the pre-existing behaviour (the
 * sandbox escalation approval is still the human decision). Inline
 * `MINT_PROJECT=…` assignments are honoured because the CLI honours them.
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
 * The model-facing action summary of an invocation: everything after the
 * global flags, control characters stripped and length-bounded, so a
 * model-supplied argv cannot reshape the approval prompt.
 */
export function renderAction(rest: readonly string[]): string {
  const cleaned = rest
    .map((token) => [...token].filter((char) => !isControlChar(char)).join(''))
    .join(' ');
  return cleaned.length <= MAX_ACTION_CHARS ? cleaned : `${cleaned.slice(0, MAX_ACTION_CHARS)}…`;
}

/** Audit reason + localized prompt copy for one cross-project write. */
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
 * Recover the target project from an approval reason this module built. The
 * name sits immediately after the prefix and cannot span a `"`; anything
 * unexpected yields `undefined`, which means "no session grant" — the next
 * write asks again.
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

/** Actionable error for a target that is not a project on this machine. */
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

/** Actionable error when the project list itself could not be read. */
export function projectProbeFailureMessage(project: string): string {
  return (
    `无法校验目标项目 "${project}"：mint 的 project list 执行失败。` +
    '跨项目操作要求可用的 mint 与项目清单，已按 fail-closed 拒绝本次调用。'
  );
}

/**
 * Names of the projects mint knows (`project list --json`).
 *
 * Returns `undefined` on any failure — callers fail closed. The command scans
 * the data directory without opening a database (`needs_conn = false`), so this
 * probe has no side effect on the target project.
 */
export async function listProjects(
  cwd: string,
  entry?: string
): Promise<readonly string[] | undefined> {
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
  return names as string[];
}
