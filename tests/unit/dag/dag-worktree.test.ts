import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, sep } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_WORKTREE_BRANCH_PREFIX,
  createWorktree,
  installedWorktrees,
  mergeWorktree,
  pruneBranches,
  pruneWorktrees,
  removeWorktree,
  worktreeBranch,
  worktreePath,
  worktreeRoot,
} from '../../../src/dag/dag-worktree.js';
import type { WorktreeDeps, WorktreeNode } from '../../../src/dag/dag-worktree.js';
import { runGit } from '../../../src/shared/git.js';
import type { GitRunResult } from '../../../src/shared/git.js';

/**
 * The node-level worktree cycle against a **real** temporary repository.
 *
 * The domain logic is orchestration over git, so a fake runner would only test
 * the fake. Every case here drives the production {@link runGit} in a throwaway
 * repo under the OS temp dir: create → commit in the worktree → merge → remove,
 * plus the two refusals that matter (an unknown base, an unmerged removal).
 *
 * Setup commits pass `-c user.*`, but the merge commits are made by the
 * production module, which cannot inject that flag: the identity has to live in
 * the repo config, or the suite fails on any machine without a global one.
 */
const SESSION = 'sess1234';

/**
 * 主会话 id 的真实形态 `session-<uuid>`。
 *
 * 前缀恰好 8 字符，正是旧 slug「清洗后取前 8 位」的取值来源：两个不同会话会得到同一个
 * `session-`，落点与分支相撞。凡是验「不同会话必须分家」的用例都用这两个 id。
 */
const SESSION_A = 'session-11111111-1111-4111-8111-111111111111';
const SESSION_B = 'session-22222222-2222-4222-8222-222222222222';

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

// --- 老 git 的假 runner ---

/** 老 git（< 2.5，没有 `worktree` 子命令）对 `git worktree …` 的实际答复。 */
const NO_WORKTREE = "git: 'worktree' is not a git command. See 'git --help'.";

/** 40 位 sha 的占位值：假 runner 不真解析 ref，只保证形状对。 */
const FAKE_SHA = 'a'.repeat(40);

/** 凑一个 runner 的返回形状；假答复不需要分开写五个字段。 */
function answer(ok: boolean, stdout = '', stderr = ''): GitRunResult {
  return { ok, stdout, stderr, code: ok ? 0 : 1 };
}

/**
 * 按参数分派的假 git。
 *
 * 真 git（本机 ≥2.5）装不出「老版本没有 worktree」这个局面，所以「失败之后才给降级
 * 指引」这条只能在假 runner 上验。默认就是一台 git 1.9.0：读路径/读 ref 这些老版本
 * 本来就有的命令照常成功，`worktree list` / `worktree add` 与 `--version` 由入参决定。
 *
 * `worktreeList` 单独给 remove 的场景用：老 git 上 list 同样会失败，但 remove 那条
 * 路径要先把目标认成「已注册」才会走到 `worktree remove`。未覆盖的命令直接 reject，
 * 假 runner 的失败模式必须是「测试红了」，不是静默空答。
 */
function fakeGit(
  options: {
    version?: GitRunResult;
    worktreeList?: GitRunResult;
    worktreeRemove?: GitRunResult;
  } = {}
): WorktreeDeps['git'] {
  const version = options.version ?? answer(true, 'git version 1.9.0\n');
  const list = options.worktreeList ?? answer(false, '', NO_WORKTREE);
  const remove = options.worktreeRemove ?? answer(false, '', NO_WORKTREE);
  return (cwd: string, args: readonly string[]): Promise<GitRunResult> => {
    const [command, second] = args;
    if (command === '--version') return Promise.resolve(version);
    if (command === 'rev-parse' && second === '--git-common-dir') {
      return Promise.resolve(answer(true, `${join(cwd, '.git')}\n`));
    }
    if (command === 'rev-parse' && second === '--verify') {
      return Promise.resolve(answer(true, `${FAKE_SHA}\n`));
    }
    if (command === 'rev-parse' && second === '--abbrev-ref') {
      return Promise.resolve(answer(true, 'main\n'));
    }
    if (command === 'rev-parse' && second === '--short=7') {
      return Promise.resolve(answer(true, `${FAKE_SHA.slice(0, 7)}\n`));
    }
    if (command === 'worktree' && second === 'list') return Promise.resolve(list);
    if (command === 'worktree' && second === 'add') {
      return Promise.resolve(answer(false, '', NO_WORKTREE));
    }
    if (command === 'worktree' && second === 'remove') return Promise.resolve(remove);
    // `prune` 清孤儿元数据：本用例假的是「老 git」，这条命令在 1.9 上也不存在，
    // 但 `pruneWorktrees` 只要求「失败被忽略」，所以给成功答复不影响断言。
    if (command === 'worktree' && second === 'prune') return Promise.resolve(answer(true));
    if (command === 'merge-base') return Promise.resolve(answer(true));
    // `installedWorktrees` 的时间列（`log -1 --format=%cI`）：假 runner 只要形状对，
    // 这一档用例断言的是「目录读不到」，与时间值无关。
    if (command === 'log') return Promise.resolve(answer(true, '2026-01-01T00:00:00+00:00\n'));
    if (command === 'status') return Promise.resolve(answer(true, ''));
    return Promise.reject(new Error(`假 git 未覆盖：${args.join(' ')}`));
  };
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'dsh-mint-wt-'));
  gitIn(repo, 'init', '-q', '-b', 'main');
  // merge 由生产模块执行，拿不到 `-c`，只能靠仓内身份，否则无全局身份的机器上必失败。
  gitIn(repo, 'config', 'user.name', 'dsh-mint test');
  gitIn(repo, 'config', 'user.email', 'test@example.invalid');
  commitFile(repo, 'README.md', '# fixture\n', 'init');
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('worktree naming', () => {
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

  it('gives two session-<uuid> ids their own slug instead of the shared session- prefix', async () => {
    // 旧 slug = 清洗后前 8 位 = `session-`：两个会话同 slug，落点与分支都撞在一起。
    // 每个会话各问一次落点与分支，断言互异、且父目录名是 uuid 的前 8 位。
    const node: WorktreeNode = { id: 'a1' };
    const rootA = await worktreeRoot(deps({ session: SESSION_A }));
    const rootB = await worktreeRoot(deps({ session: SESSION_B }));
    expect(typeof rootA).toBe('string');
    expect(typeof rootB).toBe('string');
    if (typeof rootA !== 'string' || typeof rootB !== 'string') return;
    expect(rootA).not.toBe(rootB);
    expect(basename(rootA)).toBe('11111111');
    expect(basename(rootB)).toBe('22222222');
    expect(worktreeBranch(deps({ session: SESSION_A }), node)).toBe('dsh-mint/wt/11111111/a1');
    expect(worktreeBranch(deps({ session: SESSION_A }), node)).not.toBe(
      worktreeBranch(deps({ session: SESSION_B }), node)
    );
  });

  it('falls back to a sha256 slug when stripping the session- prefix leaves nothing', async () => {
    // id 恰是前缀本身：清洗去前缀后为空，绝不能落成空目录段（路径会塌到上一级）。
    // 断言 slug 是 8 位十六进制、等于 sha256(原始 id) 前 8 位，且命名空间下正好一层。
    const root = await worktreeRoot(deps({ session: 'session-' }));
    expect(typeof root).toBe('string');
    if (typeof root !== 'string') return;
    const slug = basename(root);
    expect(slug).toMatch(/^[0-9a-f]{8}$/);
    expect(slug).toBe(createHash('sha256').update('session-').digest('hex').slice(0, 8));
    const shard = root.slice(join(repo, '.git', 'dsh-mint', 'worktrees').length + 1).split(sep);
    expect(shard).toEqual([slug]);
  });
});

describe('installedWorktrees', () => {
  it('still reads a tree left under the old session- directory', async () => {
    // 存量旧 slug 树：写侧（create/merge/remove）已按新 slug 找不到它，
    // 但只读视图必须照旧认出来——`list`/`prune` 是这类树唯一的收尾通道。
    const legacy = join(repo, '.git', 'dsh-mint', 'worktrees', 'session-', 'a1');
    gitIn(repo, 'worktree', 'add', '-q', '-b', 'legacy/a1', legacy, 'HEAD');

    const found = await installedWorktrees(deps({ session: SESSION_A }));
    const entry = found.find((item) => item.path === legacy);
    expect(entry?.session).toBe('session-');
    expect(entry?.node).toBe('a1');
  });
});

describe('node id guard', () => {
  // 非法 id 的硬门禁：subject、分支名与路径段都由 node.id 拼出，决不许它进到命令行。
  // 换成记账用的假 runner，对三个写入口各喂坏 id，断言全部拒绝且一次 git 都没调用。
  it('refuses an id that would reach a git ref, without running a single git command', async () => {
    // 三个写入口（建/合/删）都先在本地挡下：subject、分支名与路径段都由 node.id 拼出，
    // 所以「拒绝」必须发生在任何 git 命令之前，否则非法 id 已经进了命令行。
    const calls: string[] = [];
    const recording: WorktreeDeps['git'] = (_cwd, args) => {
      calls.push(args.join(' '));
      return Promise.resolve(answer(true, ''));
    };
    const guarded = deps({ git: recording });
    for (const id of ['a1#1', '..', 'a b']) {
      const created = await createWorktree(guarded, { id });
      expect(created.ok, id).toBe(false);
      if (created.ok) continue;
      expect(created.error).toContain('不可用于 git 引用');
      expect(created.error).toContain('只允许');
      expect((await mergeWorktree(guarded, { id })).ok, id).toBe(false);
      expect((await removeWorktree(guarded, { id })).ok, id).toBe(false);
    }
    expect(calls).toEqual([]);
  });
});

describe('createWorktree', () => {
  it('creates the tree and its branch from HEAD', async () => {
    const outcome = await createWorktree(deps(), { id: 'a1' });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.worktree.state).toBe('active');
    expect(outcome.worktree.path).toBe(await worktreePath(deps(), { id: 'a1' }));
    expect(outcome.worktree.path).toContain(join('.git', 'dsh-mint', 'worktrees'));
    expect(outcome.worktree.branch).toBe(worktreeBranch(deps(), { id: 'a1' }));
    expect(outcome.worktree.base).toMatch(/^[0-9a-f]{40}$/);
    // 开工点所在的分支被记下来，后续 merge 的目标就是它。
    expect(outcome.worktree.target).toBe('main');
    expect(gitIn(repo, 'worktree', 'list', '--porcelain')).toContain(outcome.worktree.path);
    // The branch really exists and is checked out there.
    expect(gitIn(outcome.worktree.path, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe(
      outcome.worktree.branch
    );
  });

  it('records the branch it was created on, not always main', async () => {
    gitIn(repo, 'checkout', '-q', '-b', 'feature');
    const outcome = await createWorktree(deps(), { id: 'a1' });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.worktree.target).toBe('feature');
    // 幂等分支也带同一个 target（重跑不该把记录擦成空）。
    const again = await createWorktree(deps(), { id: 'a1' });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.worktree.target).toBe('feature');
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

  it('does not let one session claim another session tree for the same node id', async () => {
    // 端到端隔离：两个真实 `session-<uuid>` 会话对**同一个节点 id** 各建一棵树。
    // 修前两者 slug 都是 `session-`、路径相同，B 会走幂等分支认领 A 的树。
    const a = await createWorktree(deps({ session: SESSION_A }), { id: 'a1' });
    const b = await createWorktree(deps({ session: SESSION_B }), { id: 'a1' });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(b.worktree.path).not.toBe(a.worktree.path);
    expect(b.worktree.branch).not.toBe(a.worktree.branch);
    // B 是真建出来的，不是认领 A 的树：幂等返回会带那条 note。
    expect(b.note).toBeUndefined();
    // 两棵树同时在册，且各自签出自己的分支。
    const registered = gitIn(repo, 'worktree', 'list', '--porcelain');
    expect(registered).toContain(a.worktree.path);
    expect(registered).toContain(b.worktree.path);
    expect(gitIn(a.worktree.path, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe(
      a.worktree.branch
    );
    expect(gitIn(b.worktree.path, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe(
      b.worktree.branch
    );
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
      const outcome = await createWorktree({ git, repo: notARepo, session: SESSION }, { id: 'a1' });
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.error).toContain('无法确定 git 公共目录');
    } finally {
      rmSync(notARepo, { recursive: true, force: true });
    }
  });
});

describe('mergeWorktree', () => {
  it('brings the node branch back as one recorded commit', async () => {
    const created = await createWorktree(deps(), { id: 'a1' });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    commitFile(created.worktree.path, 'feature.txt', 'work\n', 'work');

    const merged = await mergeWorktree(deps(), { id: 'a1' });
    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    expect(merged.worktree.state).toBe('merged');
    expect(merged.worktree.merged_sha).toMatch(/^[0-9a-f]{7,}$/);
    // 成功路径也要带 target：下游按它继续判定「已合并」。
    expect(merged.worktree.target).toBe('main');
    expect(gitIn(repo, 'show', 'HEAD:feature.txt')).toContain('work');
    const log = gitIn(repo, 'log', '--oneline', '-3');
    expect(log).toContain('merge a1');
    // 上库内容不得出现 mint ID：merge commit 的 subject 只有节点 id。
    expect(log).not.toMatch(/#\d/);
  });

  // 冲突契约：停在冲突态交给调用方决定，绝不自动解冲突，主树保持可 abort。
  // 让工作树与 main 各改同一文件触发冲突，断言返回 `state:'conflict'` 与完整的落盘字段。
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
    // 冲突分支同样要带 target，否则落盘记录会丢掉「合回哪里」这条契约。
    expect(merged.worktree?.target).toBe('main');
    // Left for a decision: the merge is still in progress and abortable.
    expect(gitIn(repo, 'status', '--porcelain')).toContain('UU README.md');
    gitIn(repo, 'merge', '--abort');
    // Back to a clean working tree: the worktree lives inside `.git`, so it is not
    // even untracked state in the main tree.
    expect(gitIn(repo, 'status', '--porcelain').trim()).toBe('');
  });

  it('keeps the worktree out of the main tree status without a .gitignore', async () => {
    // 落点改到 git common dir 内部的验收点：仓里**没有** `.gitignore`，
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
    commitFile(created.worktree.path, 'feature.txt', 'work\n', 'work');
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
    expect(merged.worktree.target).toBe('main');
  });
});

/**
 * 「merge 目标 = 建树时所在分支」的显式契约。
 *
 * 判据是**记录**（`deps.target`）对**当前 HEAD**，不是「永远是 main」：两个都是真
 * 分支名且不等就拒绝。缺记录与 detached 无从校验，照旧 merge。
 */
describe('mergeWorktree target guard', () => {
  it('refuses a merge when HEAD moved off the recorded branch', async () => {
    gitIn(repo, 'checkout', '-q', '-b', 'feature');
    const created = await createWorktree(deps(), { id: 'a1' });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.worktree.target).toBe('feature');

    // 建树后会话切到了别的分支：这时 merge 会合进一个调用方没预期的分支。
    gitIn(repo, 'checkout', '-q', 'main');
    const refused = await mergeWorktree(deps({ target: 'feature' }), { id: 'a1' });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    // 文案要同时点名两个分支，调用方才知道该切回哪个。
    expect(refused.error).toContain('main');
    expect(refused.error).toContain('feature');
    // 拒绝发生在 merge 之前：main 上不得留下任何合并痕迹。
    expect(gitIn(repo, 'log', '--oneline')).not.toContain('merge a1');

    // 切回建树时的分支，同一调用即成功。
    gitIn(repo, 'checkout', '-q', 'feature');
    const merged = await mergeWorktree(deps({ target: 'feature' }), { id: 'a1' });
    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    expect(merged.worktree.target).toBe('feature');
  });

  it('skips the guard when the record has no target', async () => {
    // 缺记录 = 早期建的树：无从校验，不能因此把旧 DAG 判成不可合并。
    const created = await createWorktree(deps(), { id: 'a1' });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    commitFile(created.worktree.path, 'feature.txt', 'work\n', 'work');

    const merged = await mergeWorktree(deps(), { id: 'a1' });
    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    expect(merged.worktree.state).toBe('merged');
    // 没传 target 时按当前分支记录，退回早期形态。
    expect(merged.worktree.target).toBe('main');
  });

  it('skips the guard for an empty recorded target', async () => {
    // `target: ''`（读不到当前分支时的形态）同样不是分支名，不拒。
    const created = await createWorktree(deps(), { id: 'a1' });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    commitFile(created.worktree.path, 'feature.txt', 'work\n', 'work');

    const merged = await mergeWorktree(deps({ target: '' }), { id: 'a1' });
    expect(merged.ok).toBe(true);
  });

  it('skips the guard on a detached HEAD', async () => {
    // detached 时 git 答 `HEAD`，不是分支名，比对不成立 → 照旧 merge。
    const created = await createWorktree(deps(), { id: 'a1' });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    commitFile(created.worktree.path, 'feature.txt', 'work\n', 'work');
    gitIn(repo, 'checkout', '-q', '--detach');

    const merged = await mergeWorktree(deps({ target: 'main' }), { id: 'a1' });
    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    expect(merged.worktree.merged_sha).toMatch(/^[0-9a-f]{7,}$/);
  });
});

describe('removeWorktree', () => {
  // 未合并的树默认不许删：先拒绝、再显式 force 才移除，移除后不再出现在 list 里。
  // 同一棵树连调两次 `removeWorktree`，断言第一次报「尚未合并」、带 force 的那次成功。
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
    const created = await createWorktree(deps(), { id: 'a1' });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    commitFile(created.worktree.path, 'feature.txt', 'work\n', 'work');
    expect((await mergeWorktree(deps(), { id: 'a1' })).ok).toBe(true);

    const removed = await removeWorktree(deps(), { id: 'a1' });
    expect(removed.ok).toBe(true);
    if (!removed.ok) return;
    expect(removed.worktree.state).toBe('removed');

    const again = await removeWorktree(deps(), { id: 'a1' });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.note).toContain('不存在');
  });

  it('judges the merge criterion against the recorded target branch', async () => {
    // 已合入目标分支：按记录的目标分支判定即可 remove，返回记录也带 target。
    const merged = await createWorktree(deps(), { id: 'a1' });
    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    commitFile(merged.worktree.path, 'feature.txt', 'work\n', 'work');
    expect((await mergeWorktree(deps(), { id: 'a1' })).ok).toBe(true);

    const removed = await removeWorktree(deps({ target: 'main' }), { id: 'a1' });
    expect(removed.ok).toBe(true);
    if (!removed.ok) return;
    expect(removed.worktree.state).toBe('removed');
    expect(removed.worktree.target).toBe('main');

    // 未合入目标分支：同一判据照旧拒绝，且点名的是目标分支不是 HEAD。
    const loose = await createWorktree(deps(), { id: 'b1' });
    expect(loose.ok).toBe(true);
    if (!loose.ok) return;
    commitFile(loose.worktree.path, 'other.txt', 'work\n', 'work b1');

    const refused = await removeWorktree(deps({ target: 'main' }), { id: 'b1' });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error).toContain('尚未合并');
    expect(refused.error).toContain('目标分支 main');
  });
});

/**
 * 失败之后才查版本、给可行动报错。
 *
 * 默认路径仍是 worktree：不预检（happy path 不付版本检查的成本）、不静默失败，也
 * 绝不因为失败把路径回落到主工作树。这条行为的全部价值都在失败分支上，所以三条用例
 * 都走假 runner——真 git 装不出老版本那个局面。
 */
describe('worktree 降级指引', () => {
  // 降级指引：建树失败后要补上本机 git 版本与「共享工作区串行」这条可行动替代，并指向降级 reference。
  // 用假 runner 模拟 git 1.9（没有 `worktree` 子命令），断言失败文案同时含版本、替代动作与指针。
  it('appends the local version and the shared-workspace fallback to a failed add', async () => {
    const withFake = deps({ git: fakeGit() });
    const outcome = await createWorktree(withFake, { id: 'a1' });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toContain('git version 1.9.0');
    expect(outcome.error).toContain('共享工作区串行');
    expect(outcome.error).toContain('exec-fallback.md');
    // 失败不得落到主工作树：目标路径根本没被创建（隔离没丢，也没假装成功）。
    const path = await worktreePath(withFake, { id: 'a1' });
    expect(typeof path).toBe('string');
    if (typeof path !== 'string') return;
    expect(existsSync(path)).toBe(false);
  });

  it('still forms the hint when even git --version fails', async () => {
    const withFake = deps({
      git: fakeGit({ version: answer(false, '', 'git: command not found') }),
    });
    const outcome = await createWorktree(withFake, { id: 'a1' });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    // 版本读不到不是二次失败：文案必须照旧成形，且仍指向降级动作与降级 reference。
    expect(outcome.error).toContain('git 版本未知');
    expect(outcome.error).toContain('共享工作区串行');
    expect(outcome.error).toContain('exec-fallback.md');
  });

  it('appends the same hint to a failed remove', async () => {
    const probe = deps({ git: fakeGit() });
    const path = await worktreePath(probe, { id: 'a1' });
    expect(typeof path).toBe('string');
    if (typeof path !== 'string') return;
    // `worktree remove` 只在路径被认成「已注册」时才执行，所以这条让 list 成功。
    const withFake = deps({ git: fakeGit({ worktreeList: answer(true, `worktree ${path}\n`) }) });
    const outcome = await removeWorktree(withFake, { id: 'a1' });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toContain('git version 1.9.0');
    expect(outcome.error).toContain('共享工作区串行');
    expect(outcome.error).toContain('exec-fallback.md');
  });
});

/**
 * 开工点清理（prune）：保留现场的另一半。
 *
 * 判据全部是「真的 git 在真仓里怎么答」，所以这些用例也走真临时仓。年龄一律用
 * `options` 拨时间（`nowMs` / `minAgeMs`），不去改系统时钟——树够不够老只由这两个
 * 数决定，测试要能一眼看出自己卡的是哪一档。
 */
/** 建一棵树，失败就抛（prune 的两组用例都建立在「树真的建出来了」之上）。 */
async function tree(id: string): Promise<string> {
  const created = await createWorktree(deps(), { id });
  if (!created.ok) throw new Error(`建树失败：${created.error}`);
  return created.worktree.path;
}

describe('pruneWorktrees', () => {
  // 开工点清理的验收点：已合并、干净、够老的树删掉，但分支必须留下当凭据。
  // 在真临时仓建一棵零领先的树，`minAgeMs: 0` 触发 prune 后断言目录没了、分支还在。
  it('removes a merged, clean and old tree but keeps its branch', async () => {
    // 刚建出来的树就在 HEAD 上（零领先）→ 已合并；没有未提交改动 → 干净。
    const path = await tree('a1');
    const branch = worktreeBranch(deps(), { id: 'a1' });

    const results = await pruneWorktrees(deps(), { minAgeMs: 0 });

    expect(results).toHaveLength(1);
    expect(results[0]?.verdict).toBe('removed');
    expect(results[0]?.node).toBe('a1');
    expect(results[0]?.branch).toBe(branch);
    expect(existsSync(path)).toBe(false);
    expect(gitIn(repo, 'worktree', 'list', '--porcelain')).not.toContain(path);
    // 不删分支：树没了，分支还在，退回去看/重新签出都还有凭据。
    expect(gitIn(repo, 'branch', '--list', branch)).toContain(branch);
  });

  it('keeps a tree whose branch is not merged', async () => {
    const path = await tree('a1');
    commitFile(path, 'feature.txt', 'work\n', 'work a1');

    const results = await pruneWorktrees(deps(), { minAgeMs: 0 });

    expect(results[0]?.verdict).toBe('unmerged');
    expect(existsSync(path)).toBe(true);
    expect(gitIn(repo, 'worktree', 'list', '--porcelain')).toContain(path);
  });

  it('keeps a dirty tree even when it is merged and old', async () => {
    // 脏树是「绝不 --force」那条口径的验收点：不带 --force 的 remove 自己也会拒绝。
    const path = await tree('a1');
    writeFileSync(join(path, 'uncommitted.txt'), 'wip\n');

    const results = await pruneWorktrees(deps(), { minAgeMs: 0 });

    expect(results[0]?.verdict).toBe('dirty');
    expect(existsSync(path)).toBe(true);
    expect(gitIn(repo, 'worktree', 'list', '--porcelain')).toContain(path);
  });

  it('keeps a tree younger than the minimum age', async () => {
    const path = await tree('a1');
    commitFile(path, 'feature.txt', 'work\n', 'work a1');
    const merged = await mergeWorktree(deps(), { id: 'a1' });
    expect(merged.ok).toBe(true);

    // 刚合完 5 分钟：按缺省一小时的口径还太新（时间不靠系统时钟，只靠这两个数）。
    const results = await pruneWorktrees(deps(), {
      nowMs: Date.now() + 5 * 60 * 1000,
      minAgeMs: 3_600_000,
    });

    expect(results[0]?.verdict).toBe('recent');
    expect(existsSync(path)).toBe(true);
  });

  it('cleans up the metadata git kept for a manually deleted directory', async () => {
    const path = await tree('a1');
    rmSync(path, { recursive: true, force: true });
    expect(gitIn(repo, 'worktree', 'list', '--porcelain')).toContain(path);

    const results = await pruneWorktrees(deps(), { minAgeMs: 0 });

    // 目录已被手工删掉：年龄/干净都无从测起，结论只能是「保留现场」那两档之一。
    expect(['dirty', 'failed', 'unmeasured']).toContain(results[0]?.verdict);
    // 收尾那次 `git worktree prune` 把孤儿元数据清掉，list 不再认它。
    expect(gitIn(repo, 'worktree', 'list', '--porcelain')).not.toContain(path);
    expect(gitIn(repo, 'branch', '--list', worktreeBranch(deps(), { id: 'a1' }))).toContain(
      'dsh-mint/wt/'
    );
  });

  it('keeps a tree whose directory metadata cannot be read', async () => {
    // 真 git 装不出「路径读不到但元数据还在」：假 runner 报一棵已合并、干净的树，
    // 路径却不存在 → `statSync` 失败 → 年龄不可测 → 保留（宁可不删，绝不抛）。
    // 路径仍要落在命名空间里（否则被 `installedWorktrees` 的过滤挡掉，测不到这一档）。
    const missing = join(repo, '.git', 'dsh-mint', 'worktrees', SESSION, 'a1');
    const branchRef = `branch refs/heads/${worktreeBranch(deps(), { id: 'a1' })}`;
    const withFake = deps({
      git: fakeGit({ worktreeList: answer(true, `worktree ${missing}\n${branchRef}\n`) }),
    });

    const results = await pruneWorktrees(withFake, { minAgeMs: 0 });

    expect(results[0]?.verdict).toBe('unmeasured');
    expect(results[0]?.node).toBe('a1');
  });
});

/**
 * 分支清理：开工点 prune 的另一半（树收走后长期残留在 `git branch` 里的旧分支）。
 *
 * 候选三条判据缺一不可——命名空间内、已并入 HEAD、**没有任何 worktree 检出它**；缺省
 * 只报告，`force` 才 `git branch -d`。全部对真临时仓跑生产 git，绝不碰本仓的分支。
 */
describe('pruneBranches', () => {
  /** 建一条指向 HEAD 的分支（因此已并入 HEAD），不建任何树。 */
  function branchOnly(id: string): string {
    const branch = worktreeBranch(deps(), { id });
    gitIn(repo, 'branch', branch);
    return branch;
  }

  it('reports a merged branch with no worktree and keeps it without force', async () => {
    // 一棵树在盘上（它的分支被检出，不算候选）+ 一条无树的已合并分支。
    const path = await tree('a1');
    const branch = branchOnly('b1');

    const results = await pruneBranches(deps());

    expect(results).toEqual([{ branch, session: SESSION, node: 'b1', verdict: 'kept' }]);
    // 默认只报告：分支与那棵树的目录都原地不动。
    expect(gitIn(repo, 'branch', '--list', branch)).toContain(branch);
    expect(existsSync(path)).toBe(true);
  });

  it('deletes that branch only when force is set', async () => {
    const branch = branchOnly('b1');

    const results = await pruneBranches(deps(), { force: true });

    expect(results).toEqual([{ branch, session: SESSION, node: 'b1', verdict: 'removed' }]);
    expect(gitIn(repo, 'branch', '--list', branch).trim()).toBe('');
  });

  it('keeps an unmerged branch even when no worktree holds it', async () => {
    // 先建树并提交未合并的工作，再带 force 删树（remove 不动分支）——于是它是
    // 「无树 + 未合并」这一档，只有「已并入 HEAD」那条判据能挡住它。
    const created = await createWorktree(deps(), { id: 'b1' });
    if (!created.ok) throw new Error(`建树失败：${created.error}`);
    commitFile(created.worktree.path, 'feature.txt', 'work\n', 'work b1');
    const removed = await removeWorktree(deps(), { id: 'b1' }, true);
    expect(removed.ok).toBe(true);

    const results = await pruneBranches(deps(), { force: true });

    expect(results).toEqual([]);
    expect(gitIn(repo, 'branch', '--list', worktreeBranch(deps(), { id: 'b1' }))).toContain(
      DEFAULT_WORKTREE_BRANCH_PREFIX
    );
  });

  it('keeps a merged branch that a worktree still has checked out', async () => {
    // 零领先的树 → 分支已并入 HEAD；但树还检出着它，删分支会让这棵树失去 checkout。
    const path = await tree('a1');

    const results = await pruneBranches(deps(), { force: true });

    expect(results).toEqual([]);
    expect(gitIn(repo, 'branch', '--list', worktreeBranch(deps(), { id: 'a1' }))).toContain(
      DEFAULT_WORKTREE_BRANCH_PREFIX
    );
    expect(existsSync(path)).toBe(true);
  });

  it('ignores branches outside this tool namespace', async () => {
    // 仓里手建的分支（普通命名、以及前缀下只一段的）都不该被看见，force 也不动。
    gitIn(repo, 'branch', 'feature/leftover');
    const shallow = `${DEFAULT_WORKTREE_BRANCH_PREFIX}/onlyone`;
    gitIn(repo, 'branch', shallow);

    const results = await pruneBranches(deps(), { force: true });

    expect(results).toEqual([]);
    expect(gitIn(repo, 'branch', '--list', 'feature/leftover')).toContain('feature/leftover');
    expect(gitIn(repo, 'branch', '--list', shallow)).toContain(shallow);
  });
});
