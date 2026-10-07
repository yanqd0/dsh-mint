/**
 * Node-level git worktrees for a plan DAG (#172).
 *
 * Why this exists: a batch of parallel issues that share one working tree has one
 * git index, one branch and one staging area. The plan #33 session made that
 * concrete — a commit built from a partially finished tree was not the issue it
 * claimed to be, and re-cutting the range to restore "one issue, one verifiable
 * commit" cost several full test runs. A worktree per node removes the shared
 * mutable state: the node's work is committed on its own branch, and the main
 * agent merges branches in issue order.
 *
 * Two decisions shape everything below:
 *
 * - **Inside the workspace, under the git common dir (#177).** A worktree lives
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
import { join, resolve } from 'node:path';

import type { DagWorktree } from '../shared/records.js';
import type { GitRunResult } from '../shared/git.js';

/** How many characters of the session id go into the path and the branch. */
const SESSION_PREFIX = 8;

/** Default branch prefix; the `dsh-` namespace keeps it out of user branches. */
export const DEFAULT_WORKTREE_BRANCH_PREFIX = 'dsh-mint/wt';

/**
 * Directory under the git common dir (#177).
 *
 * Deliberately **not** `.git/worktrees/`: that path is git's own metadata
 * directory for registered worktrees, and a worktree placed there collides with
 * it. The `dsh-mint/` namespace keeps this plugin's trees apart from git's.
 */
export const WORKTREE_SUBDIR = 'dsh-mint/worktrees';

/** The subset of a node a worktree operation needs. */
export interface WorktreeNode {
  id: string;
  /** The node's mint issue, used for the merge commit's subject. */
  issue?: number;
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
 * The repository's git common dir, absolute (#177).
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

/** Paths git currently registers as worktrees of this repository. */
async function registeredWorktrees(deps: WorktreeDeps): Promise<string[]> {
  const result = await deps.git(deps.repo, ['worktree', 'list', '--porcelain']);
  if (!result.ok) return [];
  return result.stdout
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length).trim());
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
  const existing = await registeredWorktrees(deps);
  if (existing.includes(path)) {
    return {
      ok: true,
      note: 'worktree 已存在（幂等返回）',
      worktree: { path, branch, base: await shortHead(deps, path), state: 'active' },
    };
  }
  const resolved = await resolveBase(deps, base);
  if (typeof resolved !== 'string') return { ok: false, error: resolved.error };
  const added = await deps.git(deps.repo, ['worktree', 'add', '-b', branch, path, resolved]);
  if (!added.ok) return { ok: false, error: `git worktree add 失败：${stderrOf(added)}` };
  return { ok: true, worktree: { path, branch, base: resolved, state: 'active' } };
}

/**
 * True when the main working tree has nothing a merge would sweep in.
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
 * Merge one node's branch back into the main branch.
 *
 * `--no-ff` is deliberate: the merge is recorded even when it could fast-forward,
 * so the issue's work stays one identifiable unit on the main branch.
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
      worktree: { path, branch, base, state: 'merged' },
    };
  }
  const issue = node.issue === undefined ? '' : ` (#${String(node.issue)})`;
  const merged = await deps.git(deps.repo, [
    'merge',
    '--no-ff',
    '-m',
    `merge ${node.id}${issue}`,
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
      worktree: { path, branch, base, state: 'conflict' },
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
      merged_sha: await shortHead(deps),
    },
  };
}

/**
 * Remove one node's worktree.
 *
 * Refuses a branch that is not merged into the main branch unless `force` is set:
 * removing the tree does not delete the branch, but losing the only checkout of
 * unmerged work is the mistake this guard prevents.
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
  const worktree: DagWorktree = { path, branch, base: await shortHead(deps, path), state: 'removed' };
  const existing = await registeredWorktrees(deps);
  if (!existing.includes(path)) {
    return { ok: true, note: 'worktree 不存在（幂等返回）', worktree };
  }
  if (!force) {
    const merged = await deps.git(deps.repo, ['merge-base', '--is-ancestor', branch, 'HEAD']);
    if (!merged.ok) {
      return {
        ok: false,
        error: `分支 ${branch} 尚未合并进主线；确认要丢弃时用 force:true`,
      };
    }
  }
  const removed = await deps.git(deps.repo, [
    'worktree',
    'remove',
    ...(force ? ['--force'] : []),
    path,
  ]);
  if (!removed.ok) return { ok: false, error: `git worktree remove 失败：${stderrOf(removed)}` };
  return { ok: true, worktree };
}
