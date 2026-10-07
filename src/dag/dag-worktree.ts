/**
 * Node-level git worktrees for a plan DAG.
 *
 * Why this exists: a batch of parallel issues that share one working tree has one
 * git index, one branch and one staging area. One batch session made that
 * concrete — a commit built from a partially finished tree was not the issue it
 * claimed to be, and re-cutting the range to restore "one issue, one verifiable
 * commit" cost several full test runs. A worktree per node removes the shared
 * mutable state: the node's work is committed on its own branch, and the main
 * agent merges branches in issue order.
 *
 * Two decisions shape everything below:
 *
 * - **Inside the workspace, under the git common dir.** A worktree lives
 *   at `<common git dir>/dsh-mint/worktrees/<session8>/<node>`, never outside the
 *   repository: the bash tool resolves `workdir` against the sandbox's workspace
 *   root, so a path outside it is unreachable for the agents that are supposed to
 *   work there. `git common dir` rather than the repo root because the repo root
 *   would show every worktree as an untracked directory in `git status` (and
 *   needed a `.gitignore` entry); git never reports its own directory.
 * - **The host runs git.** Creating and merging worktrees happens in the plugin
 *   process (like `runMint`), not through a subagent's sandboxed bash.
 *
 * This module is pure orchestration over a git runner, so the whole cycle is
 * testable against a real temporary repository with no host wiring.
 */
import { statSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';

import type { DagWorktree } from '../shared/records.js';
import type { GitRunResult } from '../shared/git.js';

/** How many characters of the session id go into the path and the branch. */
const SESSION_PREFIX = 8;

/** Default branch prefix; the `dsh-` namespace keeps it out of user branches. */
export const DEFAULT_WORKTREE_BRANCH_PREFIX = 'dsh-mint/wt';

/**
 * Directory under the git common dir.
 *
 * Deliberately **not** `.git/worktrees/`: that path is git's own metadata
 * directory for registered worktrees, and a worktree placed there collides with
 * it. The `dsh-mint/` namespace keeps this plugin's trees apart from git's.
 */
export const WORKTREE_SUBDIR = 'dsh-mint/worktrees';

/** The subset of a node a worktree operation needs. */
export interface WorktreeNode {
  id: string;
}

/** What the caller supplies; everything has a default except the git runner and repo. */
export interface WorktreeDeps {
  git(cwd: string, args: readonly string[]): Promise<GitRunResult>;
  /** The main repository root (absolute). */
  repo: string;
  /** The owning (root) session id. */
  session: string;
  /** 绝对目录覆盖（测试用）：给定时直接当根，不再取 git common dir。 */
  worktreeDir?: string;
  branchPrefix?: string;
  /**
   * 建树时记录的目标分支，由调用方从节点存储的 worktree 记录带来。
   *
   * merge/remove 只拿到 `node`，文档里的 `worktree.target` 不在它们手里；契约是
   * 「merge 目标 = 建树时所在分支」，所以这个值必须由调用方回传，否则校验与
   * 「已合并」判据只能退回按当前 HEAD 猜。
   */
  target?: string;
}

/**
 * The outcome of one worktree operation.
 *
 * `worktree` is the full new state on success, and also on a conflict — where the
 * caller must persist a `conflict` record, because `path`/`branch`/`base` are all
 * non-empty there (an empty `base` would make the stored DAG unreadable).
 */
export type WorktreeOutcome =
  | { ok: true; worktree: DagWorktree; note?: string }
  | { ok: false; error: string; conflict?: readonly string[]; worktree?: DagWorktree };

/** Short prefix of the session id, used in both the path and the branch name. */
function sessionSlug(session: string): string {
  return session.replace(/[^A-Za-z0-9_-]/g, '').slice(0, SESSION_PREFIX);
}

/**
 * The repository's git common dir, absolute.
 *
 * `rev-parse --git-common-dir` answers relative to `cwd`, so `.git` at the repo
 * root and `../.git` from a subdirectory both have to be resolved against
 * `deps.repo`. `--path-format=absolute` would be cleaner but needs git ≥ 2.31.
 */
async function commonGitDir(deps: WorktreeDeps): Promise<string | { error: string }> {
  const result = await deps.git(deps.repo, ['rev-parse', '--git-common-dir']);
  if (!result.ok) {
    return { error: `无法确定 git 公共目录（不是 git 仓？）：${stderrOf(result)}` };
  }
  return resolve(deps.repo, result.stdout.trim());
}

/** The directory one session's worktrees live in. */
export async function worktreeRoot(deps: WorktreeDeps): Promise<string | { error: string }> {
  // 覆盖目录视为绝对路径（测试用），不再拼 git common dir 与 WORKTREE_SUBDIR。
  if (deps.worktreeDir !== undefined) return join(deps.worktreeDir, sessionSlug(deps.session));
  const root = await commonGitDir(deps);
  if (typeof root !== 'string') return root;
  return join(root, WORKTREE_SUBDIR, sessionSlug(deps.session));
}

/** The path one node's worktree occupies. */
export async function worktreePath(
  deps: WorktreeDeps,
  node: WorktreeNode
): Promise<string | { error: string }> {
  const root = await worktreeRoot(deps);
  if (typeof root !== 'string') return root;
  return join(root, node.id);
}

/** The branch one node's worktree is checked out on. */
export function worktreeBranch(deps: WorktreeDeps, node: WorktreeNode): string {
  const prefix = deps.branchPrefix ?? DEFAULT_WORKTREE_BRANCH_PREFIX;
  return `${prefix}/${sessionSlug(deps.session)}/${node.id}`;
}

/** A bounded, single-line description of a failed git command. */
function stderrOf(result: GitRunResult): string {
  const text = result.stderr.trim() === '' ? result.stdout.trim() : result.stderr.trim();
  const firstLine = text.split('\n')[0] ?? '';
  return firstLine.length > 240 ? `${firstLine.slice(0, 240)}…` : firstLine;
}

/** 一棵已安装 worktree 的仓库级读数（list 的输出源；prune 也复用同一扫描）。 */
export interface InstalledWorktree {
  /** 绝对路径（`worktree list --porcelain` 的原样输出）。 */
  path: string;
  /** 该树签出的分支名；detached 时为 `''`。 */
  branch: string;
  /** 落点路径的父目录名 = 会话前 8 位（见 {@link worktreeRoot}）。 */
  session: string;
  /** 落点路径的末段名 = 节点 id。 */
  node: string;
  /** 该分支是否已并入当前 HEAD（`merge-base --is-ancestor`）。 */
  merged: boolean;
  /** 分支头提交时间（`git log -1 --format=%cI`），读不到时 `''`。 */
  tipIso: string;
}

/**
 * 本仓命名空间内**当前装着的** worktree 清单（仓库级，不读 DAG）。
 *
 * 与 {@link registeredWorktrees} 的差别有两点，都是有意为之：① 只认落在
 * `<git common dir>/dsh-mint/worktrees/<session8>/<node>` 这个命名空间里的树——
 * 用户在仓里手工建的普通 worktree 不是本工具的东西，列出来只会让人误会；② 每条带
 * 分支、是否已合并与分支头时间，供 `list` 一屏说清「哪棵树、什么状态、还要不要
 * merge」。**只保留两层深**（少一层 = 会话目录本身，多一层 = 别人的目录）。
 *
 * 判据取自 git 自己：`merge-base --is-ancestor <branch> HEAD` 成功即「已并入当前
 * HEAD」（与 {@link removeWorktree} 的收尾判据同源）；时间用**提交时间** `%cI`
 * 而不是 `%aI`，与面板上的 `at` 语义一致。两者都必须失败仍可读——明细读不到就是
 * `false` / `''`，绝不因此让整张清单落空。
 *
 * 按 `path` 排序后才返回：`git worktree list` 的顺序随创建次序变，而这里的输出会
 * 进模型上下文，同一状态必须给同一串行，否则每轮都要重新读一遍。
 */
export async function installedWorktrees(deps: WorktreeDeps): Promise<InstalledWorktree[]> {
  const root = await commonGitDir(deps);
  // 不是 git 仓（或读不到 common dir）时给空表：list 是只读视图，不是失败。
  if (typeof root !== 'string') return [];
  const result = await deps.git(deps.repo, ['worktree', 'list', '--porcelain']);
  // 老 git（< 2.5）不认 `worktree` 子命令，与 {@link registeredWorktrees} 同样
  // 落成空表：真正的失败在 `worktree add` 那步带降级文案暴露。
  if (!result.ok) return [];

  const found: InstalledWorktree[] = [];
  let path = '';
  let branch = '';
  const flush = async (): Promise<void> => {
    // 命名空间过滤在这一处收口：只有正好两层深的落点才进清单。
    if (!isNodePath(root, path)) return;
    const node = basename(path);
    const session = basename(dirname(path));
    const merged =
      branch !== '' &&
      (await deps.git(deps.repo, ['merge-base', '--is-ancestor', branch, 'HEAD'])).ok;
    found.push({ path, branch, session, node, merged, tipIso: await tipCommit(deps, branch) });
  };

  for (const line of result.stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      // 上一块到此结束；块内字段顺序由 git 保证（worktree → HEAD → branch|detached）。
      await flush();
      path = line.slice('worktree '.length).trim();
      branch = '';
      continue;
    }
    if (line.startsWith('branch ')) {
      branch = line
        .slice('branch '.length)
        .trim()
        .replace(/^refs\/heads\//, '');
    }
    // `HEAD` / `detached` / `bare` / `prunable` / 空行都不需要单独处理：
    // detached 留 `branch = ''`，`prunable` 的树仍在盘上，照旧列出。
  }
  await flush();
  return found.sort((left, right) => left.path.localeCompare(right.path));
}

/** 一条 `list` 明细的时间列：分支头提交的 ISO 时间，缺分支/读不到时 `''`。 */
async function tipCommit(deps: WorktreeDeps, branch: string): Promise<string> {
  if (branch === '') return '';
  const result = await deps.git(deps.repo, ['log', '-1', '--format=%cI', branch]);
  return result.ok ? result.stdout.trim() : '';
}

/** `path` 是否正好是 `<commonGitDir>/dsh-mint/worktrees/<session8>/<node>`（多一层少一层都不算）。 */
function isNodePath(root: string, path: string): boolean {
  const parts = path.slice(join(root, WORKTREE_SUBDIR).length + 1).split(sep);
  return parts.length === 2 && parts[0] !== '' && parts[1] !== '';
}

/** Paths git currently registers as worktrees of this repository. */
async function registeredWorktrees(deps: WorktreeDeps): Promise<string[]> {
  const result = await deps.git(deps.repo, ['worktree', 'list', '--porcelain']);
  // 老 git（< 2.5）不认 `worktree` 子命令，这里会落成空表。这是有意为之：
  // 空表被调用方读成「还没建过」，真正的失败会在随后的 `worktree add` 上暴露，
  // 并带上 {@link degradationHint} 那条降级文案——所以别在这里补救。
  if (!result.ok) return [];
  return result.stdout
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length).trim());
}

/**
 * 本机 git 的版本行（`git version 2.43.0`），读不到时 `''`。
 *
 * 只在**失败之后**调用：happy path 不该为一句提示多付一次进程开销（没坏就别查）。
 */
async function gitVersion(deps: WorktreeDeps): Promise<string> {
  const result = await deps.git(deps.repo, ['--version']);
  if (!result.ok) return '';
  // 只取第一行：`--version` 在个别包装器（如 Apple Git）下会多印几行。
  return (result.stdout.trim().split('\n')[0] ?? '').trim();
}

/**
 * `worktree add` / `worktree remove` 失败时追加的**单行**降级指引。
 *
 * 失败原因里最常见也最容易被误读成「仓库坏了」的一种，是本机 git 太老（`worktree`
 * 是 2.5 才有的子命令）：报错本身（`git: 'worktree' is not a git command`）既不点
 * 版本也不给替代路径。这里把版本、判据与**唯一**可行动作写进同一行——不预检、不静默
 * 失败、也绝不因此回落到主工作树（那等于丢掉隔离）。
 */
async function degradationHint(deps: WorktreeDeps): Promise<string> {
  const version = await gitVersion(deps);
  return (
    `（本机 ${version === '' ? 'git 版本未知' : version}；worktree 需要 git ≥ 2.5 —— ` +
    `若不支持，改走共享工作区串行：main 逐个派发子代理（一步一节点）或亲自依次执行，` +
    `见 skill references/worktree-exec.md 的「降级」节）`
  );
}

/** The repository's current `HEAD` in short form, or `''` when unreadable. */
async function shortHead(deps: WorktreeDeps, cwd = deps.repo): Promise<string> {
  const result = await deps.git(cwd, ['rev-parse', '--short=7', 'HEAD']);
  return result.ok ? result.stdout.trim() : '';
}

/**
 * 本轮 merge 的起点 commit，完整 sha（读不到时 `''`）。
 *
 * `base` 的契约是「这棵树从哪个 commit 起步」——`createWorktree` 也用完整 sha
 * （{@link resolveBase}），合并记录保持同一形态，面板与 skill 才不必区分长短。
 */
async function fullHead(deps: WorktreeDeps): Promise<string> {
  const result = await deps.git(deps.repo, ['rev-parse', 'HEAD']);
  return result.ok ? result.stdout.trim() : '';
}

/**
 * 会话仓库当前签出的分支名，读不到时 `''`。
 *
 * 这就是「开工时所在分支」的来源：worktree 建在这里的 HEAD 上，merge 也该合回
 * 这里。detached HEAD 时 git 答 `HEAD`，调用方据此走「不校验」分支。
 */
async function currentBranch(deps: WorktreeDeps): Promise<string> {
  const result = await deps.git(deps.repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return result.ok ? result.stdout.trim() : '';
}

/** Resolve a commit argument; `HEAD` when the caller supplied none. */
async function resolveBase(
  deps: WorktreeDeps,
  base: string | undefined
): Promise<string | { error: string }> {
  const ref = base === undefined || base.trim() === '' ? 'HEAD' : base.trim();
  const result = await deps.git(deps.repo, ['rev-parse', '--verify', `${ref}^{commit}`]);
  if (!result.ok) return { error: `base 不是本仓的 commit：${ref}（${stderrOf(result)}）` };
  return result.stdout.trim();
}

/**
 * Create (or reuse) one node's worktree from `base`.
 *
 * Idempotent: a path that is already a registered worktree of this repository is
 * returned as it is, so a retried call after a crash costs nothing.
 *
 * Every returned record carries `target` — the branch checked out **now**,
 * which is the branch this worktree is based on and therefore the branch a later
 * `merge` must land in. Recording it at creation time is the whole point: by
 * merge time the session may have checked out something else.
 */
export async function createWorktree(
  deps: WorktreeDeps,
  node: WorktreeNode,
  base?: string
): Promise<WorktreeOutcome> {
  const path = await worktreePath(deps, node);
  // 路径解析失败必须原样报错：静默回落到主工作树就等于丢掉隔离。
  if (typeof path !== 'string') return { ok: false, error: path.error };
  const branch = worktreeBranch(deps, node);
  // 三个返回分支共用同一个 target：它是「此刻」的 HEAD，取一次即可。
  const target = await currentBranch(deps);
  const existing = await registeredWorktrees(deps);
  if (existing.includes(path)) {
    return {
      ok: true,
      note: 'worktree 已存在（幂等返回）',
      worktree: { path, branch, base: await shortHead(deps, path), state: 'active', target },
    };
  }
  const resolved = await resolveBase(deps, base);
  if (typeof resolved !== 'string') return { ok: false, error: resolved.error };
  const added = await deps.git(deps.repo, ['worktree', 'add', '-b', branch, path, resolved]);
  if (!added.ok) {
    // 失败才查版本：这里也是老 git 唯一会暴露的出口。
    const hint = await degradationHint(deps);
    return { ok: false, error: `git worktree add 失败：${stderrOf(added)}${hint}` };
  }
  return { ok: true, worktree: { path, branch, base: resolved, state: 'active', target } };
}

/**
 * True when the session working tree has nothing a merge would sweep in.
 *
 * 「会话工作树」就是 merge 目标分支所在的那棵树（不是「主线」，见
 * {@link mergeWorktree}）。
 *
 * `--untracked-files=no` 是判据本身，不是省事：这里只关心会被 merge commit 卷走的
 * **已跟踪**改动；untracked 文件从不进 merge commit，真要覆盖时 git 自己会拒绝。加上
 * worktree 现在落在 git common dir（`.git/`）内部，本就不再出现在 `git status` 里。
 */
async function mainTreeClean(deps: WorktreeDeps): Promise<boolean> {
  const result = await deps.git(deps.repo, ['status', '--porcelain', '--untracked-files=no']);
  return result.ok && result.stdout.trim() === '';
}

/** Files a stopped merge left conflicted, as git reports them. */
async function conflictedFiles(deps: WorktreeDeps): Promise<string[]> {
  const result = await deps.git(deps.repo, ['diff', '--name-only', '--diff-filter=U']);
  if (!result.ok) return [];
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/**
 * Merge one node's branch back into the **target branch**.
 *
 * The target is the branch that was checked out when the worktree was created
 * (`createWorktree` records it on the node), *not* "main"/"master": a plan is
 * usually executed on the feature branch the session is already developing on, and
 * `deps.repo`'s HEAD is that branch. So the merge is a plain `git merge` into HEAD
 * **after** checking that HEAD is still the recorded branch — merging into a
 * branch the caller did not expect is the mistake this guard prevents.
 *
 * `--no-ff` is deliberate: the merge is recorded even when it could fast-forward,
 * so the issue's work stays one identifiable unit on the target branch. The
 * subject is `merge <node id>` and carries **no** mint id: committed content must
 * not name issue/plan/milestone numbers, and the issue ↔ commit link is registered
 * with `mint issue state commit --sha` instead of the message.
 *
 * A conflict is **not** resolved here: the merge is left stopped, the conflicted
 * files are reported, and the caller decides (resolve inside the worktree and
 * retry, or `git merge --abort`). Nothing is ever forced.
 */
export async function mergeWorktree(
  deps: WorktreeDeps,
  node: WorktreeNode
): Promise<WorktreeOutcome> {
  const path = await worktreePath(deps, node);
  // 路径解析失败必须原样报错：静默回落到主工作树就等于丢掉隔离。
  if (typeof path !== 'string') return { ok: false, error: path.error };
  const branch = worktreeBranch(deps, node);
  // 当前分支只取一次：校验、返回记录、后续判断都用同一个值。
  const now = await currentBranch(deps);
  const recorded = deps.target ?? '';
  const target = deps.target ?? now;
  // 只有「两个都确实是分支名」时才拒：缺记录（旧节点）与 detached（`HEAD`）无从
  // 校验，照旧 merge，不然旧 DAG 会突然不可合并。
  if (recorded !== '' && recorded !== 'HEAD' && now !== '' && now !== 'HEAD' && recorded !== now) {
    return {
      ok: false,
      error:
        `当前分支 ${now} 不是建树时的目标分支 ${recorded}；` +
        `先 git checkout ${recorded} 再 merge（或重建该节点的 worktree）`,
    };
  }
  const base = await fullHead(deps);
  if (!(await mainTreeClean(deps))) {
    return {
      ok: false,
      error: '主工作树有未提交改动；先 commit 或 stash，再 merge（避免把别人的改动卷进合并提交）',
    };
  }
  const ahead = await deps.git(deps.repo, ['rev-list', '--count', `HEAD..${branch}`]);
  if (ahead.ok && ahead.stdout.trim() === '0') {
    return {
      ok: true,
      note: '该分支没有新 commit（可能已合并过）',
      worktree: { path, branch, base, state: 'merged', target },
    };
  }
  // subject 只写节点 id：上库内容（含 commit message）不得出现 mint ID，issue ↔ commit
  // 的关联由 `mint issue state commit --sha` 登记，不靠 message。
  const merged = await deps.git(deps.repo, [
    'merge',
    '--no-ff',
    '-m',
    `merge ${node.id}`,
    branch,
  ]);
  if (!merged.ok) {
    const files = await conflictedFiles(deps);
    const detail = files.length === 0 ? stderrOf(merged) : files.join(', ');
    return {
      ok: false,
      conflict: files,
      // 冲突也是要落盘的节点状态：base 必须是真实 commit（空串会让整份 DAG
      // 在下次读取时被判为 unreadable）。
      worktree: { path, branch, base, state: 'conflict', target },
      error:
        `merge 冲突（已停在冲突态，不做裁决）：${detail}；` +
        `在 ${path} 内解决后重跑 merge，或 git merge --abort 放弃`,
    };
  }
  return {
    ok: true,
    worktree: {
      path,
      branch,
      base,
      state: 'merged',
      // merge 落在目标分支上，所以这个 sha 要在那里读。
      merged_sha: await shortHead(deps),
      target,
    },
  };
}

/**
 * Remove one node's worktree.
 *
 * 「已合并」的判据是**目标分支**（建树时所在的分支，由 `deps.target`
 * 传入），不是硬编码的 HEAD：会话可能已经 checkout 走了，那时按 HEAD 判定会把
 * 已合回目标分支的工作误报成未合并。缺记录（旧节点）时退回**当前分支**，读不到
 * 才落到字面 `HEAD`——字面 HEAD 只作「无从校验」的标记，不该被当成分支名写进文档。
 *
 * Refuses a branch that is not merged into the target branch unless `force` is set:
 * removing the tree does not delete the branch, but losing the only checkout of
 * unmerged work is the mistake this guard prevents.
 *
 * 返回的记录也带 `target`，下游（工具层/面板）才能继续按同一条契约判定。
 */
export async function removeWorktree(
  deps: WorktreeDeps,
  node: WorktreeNode,
  force = false
): Promise<WorktreeOutcome> {
  const path = await worktreePath(deps, node);
  // 路径解析失败必须原样报错：静默回落到主工作树就等于丢掉隔离。
  if (typeof path !== 'string') return { ok: false, error: path.error };
  const branch = worktreeBranch(deps, node);
  // 缺记录时先问当前分支（早期版本的旧节点），问不到才用字面 `HEAD`：写进文档的
  // target 必须是真分支名或明确的「无从校验」标记，不能被字面串悄悄顶上。
  const target = deps.target ?? ((await currentBranch(deps)) || 'HEAD');
  const worktree: DagWorktree = {
    path,
    branch,
    base: await shortHead(deps, path),
    state: 'removed',
    target,
  };
  const existing = await registeredWorktrees(deps);
  if (!existing.includes(path)) {
    return { ok: true, note: 'worktree 不存在（幂等返回）', worktree };
  }
  if (!force) {
    const merged = await deps.git(deps.repo, ['merge-base', '--is-ancestor', branch, target]);
    if (!merged.ok) {
      // 只有「连当前分支都读不到」时 target 才是字面 `HEAD`，别把它说成分支名。
      const where = target === 'HEAD' ? '当前 HEAD' : `目标分支 ${target}`;
      return {
        ok: false,
        error: `分支 ${branch} 尚未合并进${where}；确认要丢弃时用 force:true`,
      };
    }
  }
  const removed = await deps.git(deps.repo, [
    'worktree',
    'remove',
    ...(force ? ['--force'] : []),
    path,
  ]);
  if (!removed.ok) {
    // 与 create 同一条降级文案：merge 的失败不混进来——冲突走 conflict
    // 分支，脏树有专门文案，那是另一类失败。
    const hint = await degradationHint(deps);
    return { ok: false, error: `git worktree remove 失败：${stderrOf(removed)}${hint}` };
  }
  return { ok: true, worktree };
}

/** 一棵树至少要多老才允许自动清理（1 小时）：够短，不让旧树积压；够长，不打断「刚看完现场」。 */
export const WORKTREE_MIN_AGE_MS = 3_600_000;

/** 自动清理的可调项；两者都只在测试里传，生产走缺省。 */
export interface PruneOptions {
  /** 判定年龄的「现在」；缺省 `Date.now()`（测试可把它拨到未来）。 */
  nowMs?: number;
  /** 年龄下限；缺省 {@link WORKTREE_MIN_AGE_MS}。 */
  minAgeMs?: number;
}

/**
 * 一棵树的处置结论。
 *
 * 前四个是**保留**的原因（`verdict` 记的就是「为什么没删」），只有 `removed` 真删了；
 * `failed` 是「判定够格删但 git 拒绝」，同样保留现场。
 */
export type PruneVerdict = 'removed' | 'unmerged' | 'dirty' | 'recent' | 'unmeasured' | 'failed';

/** 一棵树的处置结果，供调用方按 `verdict` 计数与排版。 */
export interface PruneResult {
  path: string;
  session: string;
  node: string;
  branch: string;
  verdict: PruneVerdict;
}

/**
 * 分支头提交时间（毫秒），读不到时 `undefined`。
 *
 * 用 `%ct`（Unix 秒）而不是 `%cI`：这里要算差值，ISO 串还得再解析一次。
 */
async function tipCommitMs(deps: WorktreeDeps, branch: string): Promise<number | undefined> {
  if (branch === '') return undefined;
  const result = await deps.git(deps.repo, ['log', '-1', '--format=%ct', branch]);
  if (!result.ok) return undefined;
  const seconds = Number.parseInt(result.stdout.trim(), 10);
  return Number.isFinite(seconds) ? seconds * 1000 : undefined;
}

/**
 * 一棵树的年龄（毫秒），`statSync` 失败时 `undefined`（= 不可测）。
 *
 * 取**目录 mtime 与分支头提交时间的较大者**：只按 mtime 会让「刚 checkout 过」的旧树
 * 永远显得新，只按提交时间会让「提交很早但刚才还在动」的树显得老。两个都不够老才是
 * 真的没人碰。之所以用 `max` 而不是只看 mtime 一个来源：单看 mtime 无法区分「新树」
 * 与「老树被 touch」。
 */
function ageOf(path: string, nowMs: number, tipMs: number | undefined): number | undefined {
  let directoryMs: number;
  try {
    directoryMs = statSync(path).mtimeMs;
  } catch {
    // 目录都读不到（权限/已被手工删）：年龄不可测 → 保留，宁可不删。
    return undefined;
  }
  const youngest = tipMs === undefined ? directoryMs : Math.max(directoryMs, tipMs);
  return nowMs - youngest;
}

/**
 * 清理本仓命名空间内**已不需要**的 worktree，返回逐棵的处置结果。
 *
 * 这是「保留现场」策略的另一半：`remove` 是显式丢弃某一棵（人点名），`prune` 是
 * 开工点按规则收掉旧的一批（没人点名）。判据按顺序短路，任一命中即**保留**并记因：
 *
 * 1. `unmerged`：分支未并入当前 HEAD（`branch` 为空/detached 同样保留——无从判定）。
 * 2. `dirty`：该树路径下有未提交改动。这一条也是**绝不传 `--force`** 的原因：
 *    不带 `--force` 的 `git worktree remove` 自己就会拒绝脏树，两道防线同向。
 * 3. `recent`：年龄 < `minAgeMs`（缺省一小时）。
 * 4. `unmeasured`：连目录 mtime 都读不到，年龄无从判定。
 *
 * 只有「已合并 + 干净 + 够老」才真删，失败（权限、git 太老等）记 `failed` 并**不抛**：
 * 清理是收尾动作，一次失败不该让开工点停下来。**全程不删分支**——分支是回退的唯一
 * 凭据，删树不等于丢工作。扫描结束后跑一次 `git worktree prune` 清孤儿元数据（手工删
 * 过目录时元数据会残留；失败忽略）。
 *
 * 只处理 {@link installedWorktrees} 返回的树（命名空间内、正好两层深）：主工作树、
 * 用户在仓里手工建的普通 worktree 一律不碰。
 */
export async function pruneWorktrees(
  deps: WorktreeDeps,
  options: PruneOptions = {}
): Promise<PruneResult[]> {
  const nowMs = options.nowMs ?? Date.now();
  const minAgeMs = options.minAgeMs ?? WORKTREE_MIN_AGE_MS;
  const found = await installedWorktrees(deps);
  const results: PruneResult[] = [];
  for (const entry of found) {
    const where = {
      path: entry.path,
      session: entry.session,
      node: entry.node,
      branch: entry.branch,
    };
    // 1. 未合并（含 detached：branch 为空时无从证明已合并）。
    if (entry.branch === '' || !entry.merged) {
      results.push({ ...where, verdict: 'unmerged' });
      continue;
    }
    // 2. 脏树：在该树自己的路径下看，看的是这棵树而不是主工作树。
    const status = await deps.git(entry.path, ['status', '--porcelain']);
    if (!status.ok || status.stdout.trim() !== '') {
      results.push({ ...where, verdict: 'dirty' });
      continue;
    }
    // 3. 太新（含 4. 年龄不可测的分支）。
    const age = ageOf(entry.path, nowMs, await tipCommitMs(deps, entry.branch));
    if (age === undefined) {
      results.push({ ...where, verdict: 'unmeasured' });
      continue;
    }
    if (age < minAgeMs) {
      results.push({ ...where, verdict: 'recent' });
      continue;
    }
    const removed = await deps.git(deps.repo, ['worktree', 'remove', entry.path]);
    results.push({ ...where, verdict: removed.ok ? 'removed' : 'failed' });
  }
  // 孤儿元数据（目录被手工删过）只有 `prune` 清得掉；失败不影响上面的结论。
  await deps.git(deps.repo, ['worktree', 'prune']);
  return results;
}
