import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runGit } from '../../../src/shared/git.js';
import type { DagNodeView } from '../../../src/shared/records.js';
import { readDag } from '../../../src/dag/dag-store.js';
import { executeDagTool } from '../../../src/dag/dag-tool.js';
import {
  TOOL_NAME,
  WORKTREE_TOOL_DESCRIPTION,
  executeWorktreeTool,
  installWorktreeTool,
  parseWorktreeAction,
} from '../../../src/dag/worktree-tool.js';
import type { WorktreeToolOutcome } from '../../../src/dag/worktree-tool.js';
import type { AgentsLike, DshContext, ToolDefinitionLike } from '../../../src/shared/types.js';

/**
 * The standalone `worktree` tool.
 *
 * Two fixtures, both temporary: the DAG document (the tool records each git
 * outcome on a node) and a real git repository (the git side is orchestration,
 * so a fake runner would only test the fake). The domain cycle itself is covered
 * in `dag-worktree.test.ts`; these cases are about the tool's contract — what
 * lands in the document, what the answer says, and which refusals reach the
 * model.
 */
let dir: string;
let repo: string;

/** A session id short enough to keep the slug readable in assertions. */
const SESSION = 'sess-wt1';

/**
 * 合并提交也要有身份：merge 发生在工具进程内（`dag-worktree.ts`），拿不到下面
 * `commit` 的 `-c`，只能靠仓内配置，否则在没有全局身份的机器上必失败。
 */
const IDENTITY = ['-c', 'user.name=t', '-c', 'user.email=t@e.i'] as const;

/** Commit a file in `cwd` so a branch has something to merge. */
function commit(cwd: string, name: string, text: string, message: string): void {
  writeFileSync(join(cwd, name), text);
  execFileSync('git', ['add', '--', name], { cwd });
  execFileSync('git', [...IDENTITY, 'commit', '-q', '-m', message], { cwd });
}

/**
 * Commit a file and backdate **both** commit dates to 2020.
 *
 * `prune` 的年龄判定取「目录 mtime 与分支头提交时间的较大者」，所以只做旧提交还不够：
 * 调用方随后要把树目录 `utimesSync` 到同一时刻，两者一起才是「真的够老」。
 */
function commitBackdated(cwd: string, name: string, text: string, message: string): void {
  writeFileSync(join(cwd, name), text);
  execFileSync('git', ['add', '--', name], { cwd });
  execFileSync('git', [...IDENTITY, 'commit', '-q', '-m', message], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z',
      GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z',
    },
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-mint-worktree-tool-'));
  repo = mkdtempSync(join(tmpdir(), 'dsh-mint-worktree-repo-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  for (const [key, value] of [
    ['user.name', 't'],
    ['user.email', 't@e.i'],
  ] as const) {
    execFileSync('git', ['config', key, value], { cwd: repo });
  }
  commit(repo, 'README.md', '# fixture\n', 'init');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

/** Run one call with the worktree wiring: a real git runner and the temp DAG directory. */
function runWorktree(args: unknown, session: string = SESSION): Promise<WorktreeToolOutcome> {
  return executeWorktreeTool({ sessionId: session, dagDir: dir, repo, git: runGit }, args);
}

/** A DAG with one node, so the node actions have something to hang on. */
async function seedGraph(session: string = SESSION): Promise<void> {
  const init = await executeDagTool(
    { sessionId: session, dagDir: dir },
    { action: 'init', title: 'wt' }
  );
  expect(init.ok).toBe(true);
  const added = await executeDagTool(
    { sessionId: session, dagDir: dir },
    { action: 'add', nodes: [{ id: 'a1', label: '①', title: 'work', phase: 'exec', issue: 172 }] }
  );
  expect(added.ok).toBe(true);
}

/** Add one more node to the seeded graph, so a second tree has something to hang on. */
async function addNode(id: string, session: string = SESSION): Promise<void> {
  const added = await executeDagTool(
    { sessionId: session, dagDir: dir },
    { action: 'add', nodes: [{ id, label: id, title: id, phase: 'exec' }] }
  );
  expect(added.ok).toBe(true);
}

/** The node as the stored document currently has it. */
async function node(session: string = SESSION): Promise<DagNodeView | undefined> {
  const read = await readDag(session, dir);
  return read.state === 'ok' ? read.doc.nodes[0] : undefined;
}

/** A context that records what `installWorktreeTool` registers. */
function toolContext(options?: { agents?: AgentsLike }): {
  ctx: DshContext;
  registered: ToolDefinitionLike[];
} {
  const registered: ToolDefinitionLike[] = [];
  const ctx: DshContext = {
    on: () => () => {},
    tools: {
      register: (definition) => {
        registered.push(definition);
        return () => {};
      },
    },
    ...(options?.agents === undefined ? {} : { get: () => options.agents }),
  };
  return { ctx, registered };
}

describe('installWorktreeTool', () => {
  it('does nothing without a tool registry', () => {
    expect(installWorktreeTool({ on: () => () => {} })).toBeUndefined();
  });

  it('registers worktree with a host-supported schema', () => {
    const { ctx, registered } = toolContext();
    const dispose = installWorktreeTool(ctx);
    expect(dispose).toBeTypeOf('function');
    expect(registered).toHaveLength(1);
    const definition = registered[0];
    expect(definition?.name).toBe(TOOL_NAME);
    expect(definition?.name).toBe('worktree');
    expect(definition?.description).toBe(WORKTREE_TOOL_DESCRIPTION);
    expect(definition?.parameters).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['create', 'list', 'merge', 'remove', 'prune'] },
        node: { type: 'string' },
        base: { type: 'string' },
        force: { type: 'boolean' },
      },
    });
    expect(definition?.output.schema).toMatchObject({
      required: ['ok', 'summary'],
      additionalProperties: false,
    });
  });

  it('renders only the summary line', () => {
    const { ctx, registered } = toolContext();
    installWorktreeTool(ctx);
    const render = registered[0]?.output.render;
    expect(render?.({}, { ok: false, summary: '[worktree] 拒绝：x' })).toEqual([
      { type: 'text', text: '[worktree] 拒绝：x' },
    ]);
  });

  it('resolves the repository of the root session a subagent was delegated from', async () => {
    await seedGraph('root');
    const agents = new Map([
      ['child', { session: { header: { parentSession: 'root', cwd: repo } } }],
      ['root', { session: { header: {} } }],
    ]);
    const lookup: AgentsLike = { get: (id) => agents.get(id) };
    const { ctx, registered } = toolContext({ agents: lookup });
    installWorktreeTool(ctx, dir);

    // 子会话的调用也写 main 的图；仓库根取的是调用方自己的 cwd（子代理与 main
    // 同仓），所以这里给它一份真实路径。
    const outcome = (await registered[0]?.execute(
      { action: 'create', node: 'a1' },
      { name: TOOL_NAME, arguments: {}, agent: { session: { id: 'child', header: { cwd: repo } } } }
    )) as WorktreeToolOutcome;
    expect(outcome.ok).toBe(true);
    expect(outcome.summary).toContain('[worktree] create a1');
    expect((await node('root'))?.worktree?.state).toBe('active');
  });
});

describe('WORKTREE_TOOL_DESCRIPTION', () => {
  it('keeps every action name and the batch rule in the one description', () => {
    for (const marker of ['create', 'list', 'merge', 'remove', 'prune', '同批同 base']) {
      expect(WORKTREE_TOOL_DESCRIPTION, marker).toContain(marker);
    }
  });
});

describe('parseWorktreeAction', () => {
  /** The error text of a refused parse, failing loudly on an unexpected success. */
  function errorOf(raw: unknown): string {
    const parsed = parseWorktreeAction(raw);
    if (!('error' in parsed)) throw new Error(`expected a refusal, got ${JSON.stringify(parsed)}`);
    return parsed.error;
  }

  it('refuses arguments that are not an object or name no known action', () => {
    expect(errorOf(undefined)).toContain('对象');
    expect(errorOf('create')).toContain('对象');
    expect(errorOf([])).toContain('对象');
    expect(errorOf({})).toContain('action');
    expect(errorOf({ action: 'clone' })).toContain('action');
  });

  it('reads each action into its node, base and force', () => {
    expect(parseWorktreeAction({ action: 'list' })).toEqual({ action: 'list' });
    expect(parseWorktreeAction({ action: 'prune' })).toEqual({ action: 'prune' });
    expect(parseWorktreeAction({ action: 'create', node: 'a1' })).toEqual({
      action: 'create',
      node: 'a1',
    });
    expect(parseWorktreeAction({ action: 'create', node: 'a1', base: 'HEAD~1' })).toEqual({
      action: 'create',
      node: 'a1',
      base: 'HEAD~1',
    });
    expect(parseWorktreeAction({ action: 'merge', node: 'a1' })).toEqual({
      action: 'merge',
      node: 'a1',
    });
    expect(parseWorktreeAction({ action: 'remove', node: 'a1', force: true })).toEqual({
      action: 'remove',
      node: 'a1',
      force: true,
    });
  });

  it('refuses a field that means nothing to the action that carried it', () => {
    expect(errorOf({ action: 'create' })).toContain('该动作需要 node');
    expect(errorOf({ action: 'merge' })).toContain('该动作需要 node');
    expect(errorOf({ action: 'remove' })).toContain('该动作需要 node');
    expect(errorOf({ action: 'list', base: 'HEAD' })).toContain('base 只用于 create');
    expect(errorOf({ action: 'merge', node: 'a1', base: 'HEAD' })).toContain('base 只用于 create');
    expect(errorOf({ action: 'create', node: 'a1', force: true })).toContain('force 只用于 remove');
    expect(errorOf({ action: 'list', force: true })).toContain('force 只用于 remove');
  });

  it('refuses node, base and force on prune', () => {
    // prune 是仓库级动作：它按规则处理整仓，点名哪一棵是 remove 的事。
    expect(errorOf({ action: 'prune', node: 'a1' })).toContain('prune 不接受 node');
    expect(errorOf({ action: 'prune', base: 'HEAD' })).toContain('base 只用于 create');
    expect(errorOf({ action: 'prune', force: true })).toContain('force 只用于 remove');
  });

  it('validates the node id, base and force shapes', () => {
    expect(errorOf({ action: 'create', node: '' })).toContain('id');
    expect(errorOf({ action: 'create', node: 'x'.repeat(65) })).toContain('id');
    expect(errorOf({ action: 'create', node: 'a1', base: '' })).toContain('base');
    expect(errorOf({ action: 'create', node: 'a1', base: 'HEAD\n' })).toContain('控制字符');
    expect(errorOf({ action: 'remove', node: 'a1', force: 'yes' })).toContain('force');
  });
});

describe('executeWorktreeTool', () => {
  it('refuses an unknown node and a bad repo before touching git', async () => {
    await seedGraph();
    const unknown = await runWorktree({ action: 'create', node: 'nope' });
    expect(unknown.ok).toBe(false);
    expect(unknown.summary).toContain('[worktree] 拒绝：');
    expect(unknown.summary).toContain('节点不存在：nope');

    const noRepo = await executeWorktreeTool(
      { sessionId: SESSION, dagDir: dir },
      { action: 'create', node: 'a1' }
    );
    expect(noRepo.ok).toBe(false);
    expect(noRepo.summary).toContain('仓库根目录');
  });

  it('refuses a node action without a DAG and without a session', async () => {
    // 没图就没地方落记录：worktree 不在图里等于后面的收尾看不见它。
    const noGraph = await runWorktree({ action: 'create', node: 'a1' });
    expect(noGraph.ok).toBe(false);
    expect(noGraph.summary).toContain('暂无 DAG');
    expect(noGraph.summary).toContain('mint_plan_dag({action:"init"})');

    const noSession = await executeWorktreeTool(
      { sessionId: undefined, dagDir: dir, repo },
      { action: 'create', node: 'a1' }
    );
    expect(noSession.ok).toBe(false);
    expect(noSession.summary).toContain('无法确定会话');
  });

  it('creates a worktree and records it on the node', async () => {
    await seedGraph();
    const outcome = await runWorktree({ action: 'create', node: 'a1' });
    expect(outcome.ok).toBe(true);
    expect(outcome.summary).toContain('[worktree] create a1 → active');
    expect(outcome.summary).toContain(`dsh-mint/wt/${SESSION}/a1`);

    const stored = await node();
    expect(stored?.worktree?.state).toBe('active');
    expect(stored?.worktree?.path).toContain(join(repo, '.git', 'dsh-mint', 'worktrees'));
    expect(stored?.worktree?.base).toMatch(/^[0-9a-f]{40}$/);
    // #189：建树时所在的分支被记进文档，merge 时由工具层回传给 git 层做校验。
    expect(stored?.worktree?.target).toBe('main');
  });

  it('is idempotent and reports the existing worktree', async () => {
    await seedGraph();
    const first = await runWorktree({ action: 'create', node: 'a1' });
    const again = await runWorktree({ action: 'create', node: 'a1' });
    expect(again.ok).toBe(true);
    expect(again.summary).toContain('已存在');
    expect(first.summary).toBeDefined();
  });

  it('merges a node branch, records the state and reports the target-branch sha', async () => {
    await seedGraph();
    const created = await runWorktree({ action: 'create', node: 'a1' });
    expect(created.ok).toBe(true);
    const tree = (await node())?.worktree?.path;
    expect(tree).toBeDefined();
    if (tree === undefined) return;
    commit(tree, 'feature.txt', 'work\n', 'work #172');

    const merged = await runWorktree({ action: 'merge', node: 'a1' });
    expect(merged.ok).toBe(true);
    expect(merged.summary).toContain('[worktree] merge a1 → merged');
    expect(merged.summary).toContain('目标分支');

    const after = await node();
    expect(after?.worktree?.state).toBe('merged');
    expect(after?.worktree?.merged_sha).toMatch(/^[0-9a-f]{7,}$/);
    expect(
      execFileSync('git', ['show', 'HEAD:feature.txt'], { cwd: repo, encoding: 'utf8' })
    ).toContain('work');
  });

  it('refuses a merge when the repo moved off the branch the tree was cut from (#189)', async () => {
    // 贯穿工具层的验收：create 记下 target=main，会话切到 feature 后 merge 必须被拒，
    // 且拒绝理由同时点名两个分支；切回 main 后同一调用成功。
    await seedGraph();
    const created = await runWorktree({ action: 'create', node: 'a1' });
    expect(created.ok).toBe(true);

    execFileSync('git', ['checkout', '-q', '-b', 'feature'], { cwd: repo });
    const refused = await runWorktree({ action: 'merge', node: 'a1' });
    expect(refused.ok).toBe(false);
    expect(refused.summary).toContain('feature');
    expect(refused.summary).toContain('main');

    execFileSync('git', ['checkout', '-q', 'main'], { cwd: repo });
    const merged = await runWorktree({ action: 'merge', node: 'a1' });
    expect(merged.ok).toBe(true);
    expect(merged.summary).toContain('[worktree] merge a1 → merged');
  });

  it('keeps the DAG readable after a merge conflict (#177)', async () => {
    await seedGraph();
    const created = await runWorktree({ action: 'create', node: 'a1' });
    expect(created.ok).toBe(true);
    const tree = (await node())?.worktree?.path;
    if (tree === undefined) return;
    // 两侧改同一文件：merge 必然停在冲突态，走「冲突也要落盘」那条分支。
    commit(tree, 'README.md', '# from the node\n', 'node side');
    commit(repo, 'README.md', '# from main\n', 'main side');

    const conflicted = await runWorktree({ action: 'merge', node: 'a1' });
    expect(conflicted.ok).toBe(false);
    expect(conflicted.summary).toContain('merge 冲突');

    // 缺陷回归钉：#177 之前这里落盘 `base: ''`，`checkWorktree` 要求非空，
    // 于是整份 DAG 下次读取变成 unreadable。
    const read = await readDag(SESSION, dir);
    expect(read.state).toBe('ok');
    if (read.state !== 'ok') return;
    expect(read.doc.nodes[0]?.worktree?.state).toBe('conflict');
    expect(read.doc.nodes[0]?.worktree?.base).toMatch(/^[0-9a-f]{40}$/);

    execFileSync('git', ['merge', '--abort'], { cwd: repo });
  });

  it('removes a merged worktree and refuses an unmerged one without force', async () => {
    await seedGraph();
    const created = await runWorktree({ action: 'create', node: 'a1' });
    expect(created.ok).toBe(true);
    const tree = (await node())?.worktree?.path;
    if (tree === undefined) return;
    commit(tree, 'feature.txt', 'work\n', 'work #172');

    const refused = await runWorktree({ action: 'remove', node: 'a1' });
    expect(refused.ok).toBe(false);
    expect(refused.summary).toContain('尚未合并');

    const forced = await runWorktree({ action: 'remove', node: 'a1', force: true });
    expect(forced.ok).toBe(true);
    expect(forced.summary).toContain('[worktree] remove a1 → removed');
    expect((await node())?.worktree?.state).toBe('removed');
  });

  it('lists the worktrees of the repository, not of the session (#172)', async () => {
    // `list` 不读 DAG：没有图的会话（甚至没有会话）也能问仓库里有什么树。
    const empty = await executeWorktreeTool(
      { sessionId: undefined, dagDir: dir, repo, git: runGit },
      { action: 'list' }
    );
    expect(empty.ok).toBe(true);
    expect(empty.summary).toBe('[worktree] 本仓还没有 dsh-mint worktree');

    await seedGraph();
    const created = await runWorktree({ action: 'create', node: 'a1' });
    expect(created.ok).toBe(true);
    // 刚落地的树就在 HEAD 上（分支零领先）→ 明细里是 merged；要有自己的 commit
    // 才算 unmerged，这正是「还有活没合回来」的那个状态。
    const tree = (await node())?.worktree?.path;
    if (tree === undefined) return;
    commit(tree, 'feature.txt', 'work\n', 'work #172');

    const listed = await executeWorktreeTool(
      { sessionId: undefined, dagDir: dir, repo, git: runGit },
      { action: 'list' }
    );
    expect(listed.ok).toBe(true);
    // 会话前 8 位 / 节点 · 分支 · 是否已合并 · 分支头提交时间 · 绝对路径
    expect(listed.summary).toContain(`  ${SESSION}/a1`);
    expect(listed.summary).toContain(`dsh-mint/wt/${SESSION}/a1`);
    expect(listed.summary).toContain('unmerged');
    expect(listed.summary).toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(listed.summary).toContain(join(repo, '.git', 'dsh-mint', 'worktrees'));
  });

  it('leaves a worktree outside the dsh-mint namespace out of the repository list', async () => {
    await seedGraph();
    expect((await runWorktree({ action: 'create', node: 'a1' })).ok).toBe(true);
    // 同一仓里手工建的普通 worktree：不是本工具的东西，不得出现在清单里。
    const other = join(repo, 'other-tree');
    execFileSync('git', ['worktree', 'add', '-q', '-b', 'other', other], { cwd: repo });

    const listed = await executeWorktreeTool(
      { sessionId: undefined, dagDir: dir, repo, git: runGit },
      { action: 'list' }
    );
    expect(listed.summary).toContain(`${SESSION}/a1`);
    expect(listed.summary).not.toContain('other');
    expect(listed.summary).not.toContain(other);
  });

  it('marks a merged tree as merged in the repository list', async () => {
    await seedGraph();
    const created = await runWorktree({ action: 'create', node: 'a1' });
    expect(created.ok).toBe(true);
    const tree = (await node())?.worktree?.path;
    if (tree === undefined) return;
    commit(tree, 'feature.txt', 'work\n', 'work #172');
    expect((await runWorktree({ action: 'merge', node: 'a1' })).ok).toBe(true);

    const listed = await runWorktree({ action: 'list' });
    expect(listed.summary).toContain(`${SESSION}/a1`);
    expect(listed.summary).toContain('merged');
    expect(listed.summary).not.toContain('unmerged');
  });

  it('lists at most twenty rows and counts the rest', async () => {
    await seedGraph();
    for (let index = 0; index < 21; index += 1) {
      const id = `n${String(index).padStart(2, '0')}`;
      const added = await executeDagTool(
        { sessionId: SESSION, dagDir: dir },
        { action: 'add', nodes: [{ id, label: id, title: id, phase: 'exec' }] }
      );
      expect(added.ok).toBe(true);
      expect((await runWorktree({ action: 'create', node: id })).ok).toBe(true);
    }

    const listed = await runWorktree({ action: 'list' });
    expect(listed.ok).toBe(true);
    // 首行带 `[worktree] ` 前缀，先摘掉再数行。
    const rows = listed.summary
      .slice('[worktree] '.length)
      .split('\n')
      .filter((line) => !line.startsWith('  …'));
    expect(rows).toHaveLength(20);
    expect(listed.summary).toContain('  …还有 1 条');
  });
});

describe('executeWorktreeTool prune', () => {
  it('reports the trunk when the repository has no dsh-mint worktree', async () => {
    // 仓库级动作：没有 DAG、也没有会话也要能问（与 `list` 同一口径）。
    const pruned = await executeWorktreeTool(
      { sessionId: undefined, dagDir: dir, repo, git: runGit },
      { action: 'prune' }
    );
    expect(pruned.ok).toBe(true);
    expect(pruned.summary).toBe('[worktree] 本仓没有可清理的 dsh-mint worktree');
  });

  it('removes the old merged tree, keeps the unmerged one and reads out both', async () => {
    await seedGraph();
    await addNode('b1');
    // a1：分支上有一个被做旧到 2020 的 commit，再合回 main → 已合并 + 干净 + 够老。
    expect((await runWorktree({ action: 'create', node: 'a1' })).ok).toBe(true);
    const old = (await node())?.worktree?.path;
    if (old === undefined) return;
    commitBackdated(old, 'feature.txt', 'work\n', 'work a1');
    expect((await runWorktree({ action: 'merge', node: 'a1' })).ok).toBe(true);
    const when = new Date('2020-01-01T00:00:00Z');
    // 年龄取「目录 mtime 与分支头提交时间」的较大者，所以两边都要做旧。
    utimesSync(old, when, when);
    // b1：分支上有未合并的 commit（刚刚做的）→ 无论多旧都必须保留。
    expect((await runWorktree({ action: 'create', node: 'b1' })).ok).toBe(true);
    const b1 = join(repo, '.git', 'dsh-mint', 'worktrees', SESSION, 'b1');
    commit(b1, 'other.txt', 'work\n', 'work b1');
    utimesSync(b1, when, when);

    const pruned = await executeWorktreeTool(
      { sessionId: undefined, dagDir: dir, repo, git: runGit },
      { action: 'prune' }
    );
    expect(pruned.ok).toBe(true);
    expect(pruned.summary).toContain('删除 1 棵，保留 1 棵');
    expect(pruned.summary).toContain(`removed ${SESSION}/a1`);
    expect(pruned.summary).toContain(`kept ${SESSION}/b1`);
    expect(pruned.summary).toContain('未合并');
    // 现场按 verdict 落地：够格的没了，未合并的还在盘上。
    expect(existsSync(old)).toBe(false);
    expect(existsSync(b1)).toBe(true);
  });
});
