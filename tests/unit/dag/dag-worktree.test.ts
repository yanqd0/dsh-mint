import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createWorktree,
  mergeWorktree,
  removeWorktree,
  worktreeBranch,
  worktreePath,
  worktreeRoot,
} from '../../../src/dag/dag-worktree.js';
import type { WorktreeDeps, WorktreeNode } from '../../../src/dag/dag-worktree.js';
import { runGit } from '../../../src/shared/git.js';
import type { GitRunResult } from '../../../src/shared/git.js';

/**
 * The node-level worktree cycle (#172) against a **real** temporary repository.
 *
 * The domain logic is orchestration over git, so a fake runner would only test
 * the fake. Every case here drives the production {@link runGit} in a throwaway
 * repo under the OS temp dir: create → commit in the worktree → merge → remove,
 * plus the two refusals that matter (an unknown base, an unmerged removal).
 *
 * `git` is invoked with `-c user.*` in the setup only, so the repo needs no
 * global identity and the suite leaves nothing behind outside its temp dir.
 */
const SESSION = 'sess1234';
const USER = [
  '-c',
  'user.name=dsh-mint test',
  '-c',
  'user.email=test@example.invalid',
  '-c',
  'commit.gpgsign=false',
];

let repo: string;

/** Run git and fail loudly (test setup only; the code under test returns results). */
function gitIn(cwd: string, ...args: string[]): string {
  return execFileSync('git', [...args], { cwd, encoding: 'utf8' });
}

/** The production runner, with the same signature the tool injects. */
const git = (cwd: string, args: readonly string[]): Promise<GitRunResult> => runGit(cwd, args);

/** Dependencies for one case: the temp repo, a session, the default layout. */
function deps(overrides: Partial<WorktreeDeps> = {}): WorktreeDeps {
  return { git, repo, session: SESSION, ...overrides };
}

/** Commit one file in `cwd`, so a worktree branch has something to merge. */
function commitFile(cwd: string, name: string, text: string, message: string): void {
  writeFileSync(join(cwd, name), text);
  gitIn(cwd, 'add', '--', name);
  gitIn(cwd, ...USER, 'commit', '-q', '-m', message);
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'dsh-mint-wt-'));
  gitIn(repo, 'init', '-q', '-b', 'main');
  commitFile(repo, 'README.md', '# fixture\n', 'init');
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('worktree naming (#172/#177)', () => {
  it('keeps the path under the git common dir and one session directory', async () => {
    const node: WorktreeNode = { id: 'a1' };
    const root = await worktreeRoot(deps());
    expect(typeof root).toBe('string');
    if (typeof root !== 'string') return;
    expect(root.startsWith(repo)).toBe(true);
    expect(root).toContain(join('.git', 'dsh-mint', 'worktrees'));
    expect(await worktreePath(deps(), node)).toBe(join(root, 'a1'));
    expect(worktreeBranch(deps(), node)).toBe(`dsh-mint/wt/${SESSION}/a1`);
  });

  it('sanitises the session slug so a hostile id cannot escape the directory', async () => {
    // Real session ids are already `[A-Za-z0-9_-]` (`isValidDagSession`), so this
    // is defence in depth: whatever reaches the path builder stays one component,
    // even when it is truncated to the session prefix.
    const hostile = deps({ session: '../../etc/passwd' });
    const root = await worktreeRoot(hostile);
    expect(typeof root).toBe('string');
    if (typeof root !== 'string') return;
    expect(root.startsWith(join(repo, '.git', 'dsh-mint', 'worktrees'))).toBe(true);
    expect(root).not.toContain('..');
    expect(root.endsWith('etcpassw')).toBe(true);
  });
});

describe('createWorktree (#172)', () => {
  it('creates the tree and its branch from HEAD', async () => {
    const outcome = await createWorktree(deps(), { id: 'a1', issue: 172 });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.worktree.state).toBe('active');
    expect(outcome.worktree.path).toBe(await worktreePath(deps(), { id: 'a1' }));
    expect(outcome.worktree.path).toContain(join('.git', 'dsh-mint', 'worktrees'));
    expect(outcome.worktree.branch).toBe(worktreeBranch(deps(), { id: 'a1' }));
    expect(outcome.worktree.base).toMatch(/^[0-9a-f]{40}$/);
    expect(gitIn(repo, 'worktree', 'list', '--porcelain')).toContain(outcome.worktree.path);
    // The branch really exists and is checked out there.
    expect(gitIn(outcome.worktree.path, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe(
      outcome.worktree.branch
    );
  });

  it('accepts an explicit base (the parallel-batch contract)', async () => {
    const base = gitIn(repo, 'rev-parse', 'HEAD').trim();
    commitFile(repo, 'later.txt', 'x\n', 'later commit');
    const outcome = await createWorktree(deps(), { id: 'a1' }, base);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // The worktree must not see the commit made after the requested base.
    const log = gitIn(outcome.worktree.path, 'log', '--oneline');
    expect(log).not.toContain('later commit');
  });

  it('is idempotent when the worktree is already registered', async () => {
    const first = await createWorktree(deps(), { id: 'a1' });
    const again = await createWorktree(deps(), { id: 'a1' });
    expect(again.ok).toBe(true);
    if (!again.ok || !first.ok) return;
    expect(again.note).toContain('已存在');
    expect(again.worktree.path).toBe(first.worktree.path);
  });

  it('refuses a base that is not a commit of this repository', async () => {
    const outcome = await createWorktree(deps(), { id: 'a1' }, 'deadbeefdeadbeef');
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toContain('base 不是本仓的 commit');
  });

  it('refuses a directory that is not a git repository instead of using it', async () => {
    // 路径解析失败必须原样报错：静默回落到主工作树就等于丢掉隔离。
    const notARepo = mkdtempSync(join(tmpdir(), 'dsh-mint-wt-nogit-'));
    try {
      const outcome = await createWorktree(
        { git, repo: notARepo, session: SESSION },
        { id: 'a1' }
      );
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.error).toContain('无法确定 git 公共目录');
    } finally {
      rmSync(notARepo, { recursive: true, force: true });
    }
  });
});

describe('mergeWorktree (#172)', () => {
  it('brings the node branch back as one recorded commit', async () => {
    const created = await createWorktree(deps(), { id: 'a1', issue: 172 });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    commitFile(created.worktree.path, 'feature.txt', 'work\n', 'work #172');

    const merged = await mergeWorktree(deps(), { id: 'a1', issue: 172 });
    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    expect(merged.worktree.state).toBe('merged');
    expect(merged.worktree.merged_sha).toMatch(/^[0-9a-f]{7,}$/);
    // The file is on the main branch now, and the merge is recorded.
    expect(gitIn(repo, 'show', 'HEAD:feature.txt')).toContain('work');
    expect(gitIn(repo, 'log', '--oneline', '-3')).toContain('merge a1 (#172)');
  });

  it('reports a conflict and leaves the main tree stopped (no auto-resolution)', async () => {
    const created = await createWorktree(deps(), { id: 'a1' });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    commitFile(created.worktree.path, 'README.md', '# from the node\n', 'node side');
    commitFile(repo, 'README.md', '# from main\n', 'main side');

    const merged = await mergeWorktree(deps(), { id: 'a1' });
    expect(merged.ok).toBe(false);
    if (merged.ok) return;
    expect(merged.conflict).toContain('README.md');
    expect(merged.error).toContain('merge 冲突');
    // 冲突也是要落盘的节点状态：path/branch/base 都必须齐备，base 为真实 commit
    // （空串会让整份 DAG 在下次读取时被判为 unreadable）。
    expect(merged.worktree?.state).toBe('conflict');
    expect(merged.worktree?.base).toMatch(/^[0-9a-f]{40}$/);
    expect(merged.worktree?.path).toBe(created.worktree.path);
    // Left for a decision: the merge is still in progress and abortable.
    expect(gitIn(repo, 'status', '--porcelain')).toContain('UU README.md');
    gitIn(repo, 'merge', '--abort');
    // Back to a clean working tree: the worktree lives inside `.git`, so it is not
    // even untracked state in the main tree.
    expect(gitIn(repo, 'status', '--porcelain').trim()).toBe('');
  });

  it('keeps the worktree out of the main tree status without a .gitignore', async () => {
    // 落点改到 git common dir 内部（#177）的验收点：仓里**没有** `.gitignore`，
    // 也不加 `--untracked-files=no`，主树仍必须看不见这棵树。
    expect(() => gitIn(repo, 'status', '--porcelain')).not.toThrow();
    const created = await createWorktree(deps(), { id: 'a1' });
    expect(created.ok).toBe(true);
    expect(gitIn(repo, 'status', '--porcelain').trim()).toBe('');
    // 反过来确认它确实落在盘上，不是「没建出来所以干净」。
    expect(gitIn(repo, 'worktree', 'list', '--porcelain')).toContain(
      join('.git', 'dsh-mint', 'worktrees')
    );
  });

  it('refuses to merge into a main tree with tracked changes', async () => {
    const created = await createWorktree(deps(), { id: 'a1' });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    commitFile(created.worktree.path, 'feature.txt', 'work\n', 'work #172');
    // A tracked file modified but not committed: exactly what a merge would drag
    // into its commit. (The worktree inside `.git` must NOT count — see the
    // successful-merge and status cases above, where no `.gitignore` exists.)
    writeFileSync(join(repo, 'README.md'), '# dirty\n');

    const merged = await mergeWorktree(deps(), { id: 'a1' });
    expect(merged.ok).toBe(false);
    if (merged.ok) return;
    expect(merged.error).toContain('未提交改动');
  });

  it('reports a branch with nothing to merge instead of failing', async () => {
    await createWorktree(deps(), { id: 'a1' });
    const merged = await mergeWorktree(deps(), { id: 'a1' });
    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    expect(merged.note).toContain('没有新 commit');
    expect(merged.worktree.state).toBe('merged');
  });
});

describe('removeWorktree (#172)', () => {
  it('refuses an unmerged branch, then removes it with force', async () => {
    const created = await createWorktree(deps(), { id: 'a1' });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    commitFile(created.worktree.path, 'feature.txt', 'work\n', 'work');

    const refused = await removeWorktree(deps(), { id: 'a1' });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error).toContain('尚未合并');

    const forced = await removeWorktree(deps(), { id: 'a1' }, true);
    expect(forced.ok).toBe(true);
    if (!forced.ok) return;
    expect(forced.worktree.state).toBe('removed');
    expect(gitIn(repo, 'worktree', 'list', '--porcelain')).not.toContain(forced.worktree.path);
  });

  it('removes a merged worktree and is idempotent afterwards', async () => {
    const created = await createWorktree(deps(), { id: 'a1', issue: 172 });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    commitFile(created.worktree.path, 'feature.txt', 'work\n', 'work #172');
    expect((await mergeWorktree(deps(), { id: 'a1', issue: 172 })).ok).toBe(true);

    const removed = await removeWorktree(deps(), { id: 'a1' });
    expect(removed.ok).toBe(true);
    if (!removed.ok) return;
    expect(removed.worktree.state).toBe('removed');

    const again = await removeWorktree(deps(), { id: 'a1' });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.note).toContain('不存在');
  });
});
