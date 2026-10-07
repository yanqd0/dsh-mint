import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { dagFilePath, readDag, updateDag } from '../../../src/dag/dag-store.js';
import { clearMeasurements, lastMeasurement } from '../../../src/dag/dag-metrics.js';
import { runGit } from '../../../src/shared/git.js';
import type { DagNodeView } from '../../../src/shared/records.js';
import { installDagLifecycle } from '../../../src/dag/dag-lifecycle.js';
import {
  DAG_TOOL_DESCRIPTION,
  TOOL_NAME,
  executeDagTool,
  installDagTool,
  rootSessionId,
} from '../../../src/dag/dag-tool.js';
import type { DagToolOutcome } from '../../../src/dag/dag-tool.js';
import type {
  AgentCwdLike,
  AgentsLike,
  DshContext,
  SessionProjectionsLike,
  ToolDefinitionLike,
} from '../../../src/shared/types.js';

/**
 * The `mint_plan_dag` surface (plan #31).
 *
 * Every case runs against a **temporary directory**: the shipped default is
 * `/tmp/mint/dag`, and a test that wrote there would delete a real session's
 * graph (or, worse, pass because of one).
 */
let dir: string;

/** The session the worktree cases own; short enough to keep the slug readable. */
const SESSION = 'sess-wt1';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-mint-dag-tool-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Run one call for `session`, over the temp directory. */
function run(session: string | undefined, args: unknown): Promise<DagToolOutcome> {
  return executeDagTool({ sessionId: session, dagDir: dir }, args);
}

/**
 * Run one call with the worktree wiring (#172): a real git runner against a real
 * repository, and the temp DAG directory.
 */
function runWorktree(repo: string, args: unknown): Promise<DagToolOutcome> {
  return executeDagTool({ sessionId: SESSION, dagDir: dir, repo, git: runGit }, args);
}

/** A context that records what `installDagTool` registers. */
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

describe('installDagTool', () => {
  it('does nothing without a tool registry', () => {
    expect(installDagTool({ on: () => () => {} })).toBeUndefined();
  });

  it('registers mint_plan_dag with a host-supported schema', () => {
    const { ctx, registered } = toolContext();
    const dispose = installDagTool(ctx);
    expect(dispose).toBeTypeOf('function');
    expect(registered).toHaveLength(1);
    const definition = registered[0];
    expect(definition?.name).toBe(TOOL_NAME);
    expect(definition?.name).toBe('mint_plan_dag');
    expect(definition?.description).toBe(DAG_TOOL_DESCRIPTION);
    expect(definition?.parameters).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['init', 'add', 'set', 'get', 'wt', 'merge'] },
        status: { type: 'string', enum: ['pending', 'running', 'done'] },
        verdict: { type: 'string', enum: ['pass', 'fail'] },
        tokens: { type: 'integer' },
        op: { type: 'string', enum: ['create', 'list', 'remove'] },
        node: { type: 'string' },
        base: { type: 'string' },
        force: { type: 'boolean' },
        nodes: { type: 'array' },
        edges: { type: 'array' },
      },
    });
    expect(definition?.output.schema).toMatchObject({
      required: ['ok', 'summary'],
      additionalProperties: false,
    });
  });

  it('renders only the summary line', () => {
    const { ctx, registered } = toolContext();
    installDagTool(ctx);
    const render = registered[0]?.output.render;
    expect(render?.({}, { ok: false, summary: '[plan-dag] 拒绝：x' })).toEqual([
      { type: 'text', text: '[plan-dag] 拒绝：x' },
    ]);
  });

  it('writes the DAG of the root session a subagent was delegated from', async () => {
    const agents = new Map<string, AgentCwdLike>([
      ['child', { session: { header: { parentSession: 'root' } } }],
      ['mid', { session: { header: { parentSession: 'root' } } }],
      ['root', { session: { header: {} } }],
    ]);
    const lookup: AgentsLike = {
      get: (id) => agents.get(id),
    };
    const { ctx, registered } = toolContext({ agents: lookup });
    installDagTool(ctx, dir);
    const execute = registered[0]?.execute;

    // The child's own session is not the owner: the write lands on the root's
    // file, which is the graph the main session's panel draws (plan #31 §3).
    const added = (await execute?.({ action: 'init', title: '计划' }, {
      name: TOOL_NAME,
      arguments: {},
      agent: { session: { id: 'child', header: { parentSession: 'root' } } },
    })) as DagToolOutcome;
    expect(added.ok).toBe(true);
    expect(added.summary).toContain('session root');

    const fetched = (await execute?.({ action: 'get' }, {
      name: TOOL_NAME,
      arguments: {},
      agent: { session: { id: 'mid', header: { parentSession: 'root' } } },
    })) as DagToolOutcome;
    expect(fetched.ok).toBe(true);
    expect(fetched.summary).toContain('节点 0');
  });

  it('refuses a call it cannot attribute to a session', async () => {
    const { ctx, registered } = toolContext();
    installDagTool(ctx, dir);
    const outcome = (await registered[0]?.execute({ action: 'get' }, {
      name: TOOL_NAME,
      arguments: {},
    })) as DagToolOutcome;
    expect(outcome.ok).toBe(false);
    expect(outcome.summary).toContain('无法确定会话');
  });
});

describe('rootSessionId', () => {
  const agents: AgentsLike = {
    get: (id) =>
      ({
        root: { session: { header: {} } },
        mid: { session: { header: { parentSession: 'root' } } },
        child: { session: { header: { parentSession: 'mid' } } },
      })[id],
  };

  it('walks a delegation chain up to its root', () => {
    expect(rootSessionId({ session: { id: 'child' } }, agents)).toBe('root');
    // A middle session is not the root: the graph belongs to the top.
    expect(rootSessionId({ session: { id: 'mid' } }, agents)).toBe('root');
    expect(rootSessionId({ session: { id: 'root' } }, agents)).toBe('root');
  });

  it('gives up instead of looping on a cyclic chain', () => {
    const cyclic: AgentsLike = {
      get: (id) => ({ session: { header: { parentSession: id === 'a' ? 'b' : 'a' } } }),
    };
    expect(rootSessionId({ session: { id: 'a' } }, cyclic)).toBeUndefined();
  });

  it('returns undefined without an id or a registry', () => {
    expect(rootSessionId(undefined, agents)).toBeUndefined();
    expect(rootSessionId({ session: {} }, agents)).toBeUndefined();
    expect(rootSessionId({ session: { id: 'child' } }, undefined)).toBe('child');
  });
});

describe('executeDagTool', () => {
  const SESSION = 's1';

  it('walks init → add → set → get and answers with a compact summary', async () => {
    const init = await run(SESSION, { action: 'init', title: '宿主面 DAG' });
    expect(init.ok).toBe(true);
    expect(init.summary).toBe('[plan-dag] 已初始化 DAG「宿主面 DAG」（session s1）');

    const add = await run(SESSION, {
      action: 'add',
      nodes: [
        { id: 'a', label: '总①', title: '第一轮', phase: 'exec' },
        { id: 'b', label: '总②', title: '第二轮', phase: 'exec', depends_on: ['a'] },
      ],
      edges: [],
    });
    expect(add.ok).toBe(true);
    expect(add.summary).toContain('+2 节点 / +0 边');
    // `depends_on` is stored as the node's dependency, not as a second edge.
    expect(add.summary).toContain('节点 2，边 0');

    const set = await run(SESSION, { action: 'set', id: 'a', status: 'running' });
    expect(set.ok).toBe(true);
    expect(set.summary).toContain('a → running');
    expect(set.summary).toContain('running 1');

    const get = await run(SESSION, { action: 'get' });
    expect(get.ok).toBe(true);
    // One or two lines, never the graph itself (#61).
    expect(get.summary.split('\n').length).toBeLessThanOrEqual(2);
    expect(get.summary).toContain('节点 2，边 0：pending 1 / running 1 / done 0');
    expect(get.summary).toContain('总①(a)');
  });

  it('reports a session without a DAG as an empty state, not an error', async () => {
    const outcome = await run(SESSION, { action: 'get' });
    expect(outcome).toEqual({ ok: true, summary: '[plan-dag] 本会话暂无 DAG' });
  });

  // #168: `set status="done"` is often the last moment the child session is
  // still alive, so the tool takes the node's final measurement right there —
  // after its own write, so the answer can never be delayed by a measurement.
  describe('persists a sample when a node settles (#168)', () => {
    const CHILD = 'child-168';

    // The measurement cache is process-wide by design; these cases share one
    // node id, so each starts from an empty cache.
    beforeEach(() => {
      clearMeasurements();
    });

    /** The agent registry and projections one measurable child needs. */
    function measurableHost(): {
      agents: AgentsLike;
      projections: SessionProjectionsLike;
    } {
      const child = { id: CHILD, header: {} };
      const states = new Map<unknown, Record<string, unknown>>([
        [
          child,
          {
            tokenUsage: {
              totals: {
                uncachedInputTokens: 3,
                outputTokens: 5,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
              },
            },
            subagentTiming: { settledMs: 1200, active: null },
          },
        ],
      ]);
      return {
        // Only the child this case is about: any other agent id is one the host
        // no longer knows, which is the case the tool has to survive.
        agents: { get: (id) => (id === CHILD ? { session: child } : undefined) },
        projections: { stateOf: (target, key) => states.get(target)?.[key] },
      };
    }

    /** Seed one running node that already names its child session. */
    async function seedRunningNode(agent = CHILD): Promise<void> {
      expect((await run(SESSION, { action: 'init', title: 'plan' })).ok).toBe(true);
      const added = await run(SESSION, {
        action: 'add',
        nodes: [{ id: 'a', label: '总①', title: '第一轮', phase: 'exec' }],
      });
      expect(added.ok).toBe(true);
      const started = await run(SESSION, { action: 'set', id: 'a', status: 'running', agent });
      expect(started.ok).toBe(true);
    }

    it('stores the reading next to the node it settles', async () => {
      await seedRunningNode();
      const host = measurableHost();
      const outcome = await executeDagTool(
        { sessionId: SESSION, dagDir: dir, ...host },
        { action: 'set', id: 'a', status: 'done', verdict: 'pass' }
      );
      expect(outcome.ok).toBe(true);

      const read = await readDag(SESSION, dir);
      expect(read.state).toBe('ok');
      if (read.state !== 'ok') return;
      const sample = read.doc.samples?.['a'];
      expect(sample?.tokens).toBe(8);
      // A settled node's timing is the projection's own `settledMs`.
      expect(sample?.elapsed_ms).toBe(1200);
      expect(typeof sample?.at).toBe('number');
      // The verdict the model reported is untouched by the measurement.
      expect(read.doc.nodes[0]).toMatchObject({ status: 'done', verdict: 'pass' });
      // The cache keeps the reading *and* its stamp, so a later fallback write
      // cannot date a measurement with the moment it happened to be written.
      expect(lastMeasurement(SESSION, 'a')).toMatchObject({ tokens: 8, elapsed_ms: 1200 });
      expect(typeof lastMeasurement(SESSION, 'a')?.at).toBe('number');
    });

    it('writes no sample when the node names a child the host cannot resolve', async () => {
      await seedRunningNode('gone');
      const host = measurableHost();
      const outcome = await executeDagTool(
        { sessionId: SESSION, dagDir: dir, ...host },
        { action: 'set', id: 'a', status: 'done', verdict: 'pass' }
      );
      expect(outcome.ok).toBe(true);

      const read = await readDag(SESSION, dir);
      expect(read.state).toBe('ok');
      if (read.state !== 'ok') return;
      expect(read.doc.samples).toBeUndefined();
      expect(lastMeasurement(SESSION, 'a')).toBeUndefined();
    });

    it('writes no sample without a projection registry', async () => {
      await seedRunningNode();
      const { agents } = measurableHost();
      const outcome = await executeDagTool(
        { sessionId: SESSION, dagDir: dir, agents },
        { action: 'set', id: 'a', status: 'done', verdict: 'pass' }
      );
      expect(outcome.ok).toBe(true);

      const read = await readDag(SESSION, dir);
      expect(read.state).toBe('ok');
      if (read.state !== 'ok') return;
      expect(read.doc.samples).toBeUndefined();
    });

    it('does not measure a node that is only being started', async () => {
      // The same host that answers the `done` case: only the status decides
      // whether a measurement is taken, so a `running` node stays unmeasured.
      await seedRunningNode();
      const host = measurableHost();
      const outcome = await executeDagTool(
        { sessionId: SESSION, dagDir: dir, ...host },
        { action: 'set', id: 'a', status: 'running' }
      );
      expect(outcome.ok).toBe(true);

      const read = await readDag(SESSION, dir);
      expect(read.state).toBe('ok');
      if (read.state !== 'ok') return;
      expect(read.doc.samples).toBeUndefined();
      expect(lastMeasurement(SESSION, 'a')).toBeUndefined();
    });
  });

  it('refuses add/set before init without creating a file', async () => {
    const add = await run(SESSION, {
      action: 'add',
      nodes: [{ id: 'a', label: '总①', title: 't', phase: 'exec' }],
    });
    expect(add.ok).toBe(false);
    expect(add.summary).toContain('暂无 DAG');
    // Nothing was written: the next read still sees the empty state.
    const get = await run(SESSION, { action: 'get' });
    expect(get.summary).toContain('暂无 DAG');
  });

  it('rejects the modelled graph while keeping the stored one intact', async () => {
    await run(SESSION, { action: 'init', title: 'x' });
    await run(SESSION, {
      action: 'add',
      nodes: [{ id: 'a', label: '总①', title: 't', phase: 'exec' }],
    });

    const refused: Array<[label: string, args: unknown, reason: string]> = [
      [
        'unknown dependency',
        { action: 'add', nodes: [{ id: 'b', label: '总②', title: 't', phase: 'exec', depends_on: ['ghost'] }] },
        '未知依赖',
      ],
      [
        // `edges` uses the same direction as `depends_on`, so this cycle only
        // exists once the two declarations are read together.
        'cycle',
        {
          action: 'add',
          nodes: [
            { id: 'b', label: '总②', title: 't', phase: 'exec', depends_on: ['c'] },
            { id: 'c', label: '总③', title: 't', phase: 'exec' },
          ],
          edges: [['b', 'c']],
        },
        '成环',
      ],
      [
        'duplicate id',
        { action: 'add', nodes: [{ id: 'a', label: 'dup', title: 't', phase: 'exec' }] },
        '已存在',
      ],
      [
        'over-long label',
        { action: 'add', nodes: [{ id: 'b', label: '超长标签啊呀哈', title: 't', phase: 'exec' }] },
        'label',
      ],
      ['unknown node', { action: 'set', id: 'ghost', status: 'done' }, '节点不存在'],
      ['verdict on a non-terminal node', { action: 'set', id: 'a', status: 'running', verdict: 'pass' }, 'verdict'],
      ['unknown verdict', { action: 'set', id: 'a', status: 'done', verdict: 'maybe' }, 'verdict'],
    ];
    const accepted: string[] = [];
    for (const [label, args, reason] of refused) {
      const outcome = await run(SESSION, args);
      if (outcome.ok) accepted.push(`${label}: ${outcome.summary}`);
      expect(outcome.summary).toContain('[plan-dag] 拒绝：');
      expect(outcome.summary).toContain(reason);
    }
    // Named, so a wrongly-accepted case reports which one instead of a bare
    // "expected true to be false".
    expect(accepted).toEqual([]);

    // Every refusal left the document as it was.
    const get = await run(SESSION, { action: 'get' });
    expect(get.summary).toContain('节点 1，边 0');
  });

  it('renders the wrote verdict for a settled node', async () => {
    await run(SESSION, { action: 'init' });
    await run(SESSION, {
      action: 'add',
      nodes: [{ id: 'a', label: '总①', title: 't', phase: 'exec' }],
    });
    const outcome = await run(SESSION, {
      action: 'set',
      id: 'a',
      status: 'done',
      verdict: 'pass',
      note: '结论',
      tokens: 1200,
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.summary).toContain('a → done/pass');
    expect(outcome.summary).toContain('done 1');
  });

  it('refuses malformed arguments and a missing session', async () => {
    const missingAction = await run(SESSION, {});
    expect(missingAction.ok).toBe(false);
    expect(missingAction.summary).toContain('action');

    const badShape = await run(SESSION, 'nope');
    expect(badShape.ok).toBe(false);
    expect(badShape.summary).toContain('对象');

    const noSession = await executeDagTool({ sessionId: undefined, dagDir: dir }, { action: 'get' });
    expect(noSession.ok).toBe(false);
    expect(noSession.summary).toContain('无法确定会话');

    const badSession = await run('../../etc/passwd', { action: 'get' });
    expect(badSession.ok).toBe(false);
    expect(badSession.summary).toContain('不可用于路径');
  });

  it('names an unreadable file instead of guessing at its contents', async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(dagFilePath(SESSION, dir), '{ not json', 'utf8');
    const get = await run(SESSION, { action: 'get' });
    expect(get.ok).toBe(false);
    expect(get.summary).toContain('[plan-dag] DAG 不可读');
    expect(get.summary).toContain('invalid JSON');
    // `init` is the documented reset (`notes/plan-dag.md` §2.2): it is the way
    // out of a file that can no longer be read, and it replaces the contents.
    const init = await run(SESSION, { action: 'init', title: '重建' });
    expect(init.ok).toBe(true);
    const after = await run(SESSION, { action: 'get' });
    expect(after.ok).toBe(true);
    expect(after.summary).toContain('节点 0，边 0');
  });
});

/**
 * The subagent ↔ node pairing (plan #31 §3).
 *
 * The pair is the host's second opinion about a node: the model claims a node is
 * running, the host knows whether the child it delegated actually started and
 * how it ended. Both listeners are fire-and-forget, so every case settles with a
 * short tick before reading the file back.
 */
describe('installDagLifecycle', () => {
  interface Harness {
    start: (info: { runId: string; id: string }) => void;
    end: (info: {
      runId: string;
      id: string;
      stopReason?: string;
      lastAssistantMessage?: readonly unknown[];
    }) => void;
  }

  /** A context whose listeners are captured, with every child under `parent`. */
  function lifecycle(parent: string): Harness {
    const listeners: Record<string, (info: never) => void> = {};
    const ctx: DshContext = {
      on: (event, listener) => {
        listeners[event] = listener as (info: never) => void;
        return () => {};
      },
      get: () => ({ get: () => ({ session: { header: { parentSession: parent } } }) }),
    };
    installDagLifecycle(ctx, dir);
    return {
      start: (info) => listeners['subagent/start']?.(info as never),
      end: (info) => listeners['subagent/end']?.(info as never),
    };
  }

  /** One document with a single node, written through the real store. */
  async function seedNode(
    session: string,
    node: Omit<DagNodeView, 'depends_on' | 'updated_at'>
  ): Promise<void> {
    const update = await updateDag(session, () => ({
      doc: {
        version: 1 as const,
        session,
        title: 'DAG',
        revision: 1,
        created_at: 'T',
        updated_at: 'T',
        nodes: [{ depends_on: [], updated_at: 'T', ...node }],
        edges: [],
      },
    }), dir);
    expect(update.ok).toBe(true);
  }

  const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

  it('backfills the agent id on the last running node without one', async () => {
    await seedNode('root', { id: 'a', label: '总①', title: 't', phase: 'exec', status: 'running' });
    const lifecycleEvents = lifecycle('root');
    lifecycleEvents.start({ runId: 'r1', id: 'child' });
    await tick();
    const read = await readDag('root', dir);
    expect(read.state).toBe('ok');
    if (read.state !== 'ok') return;
    expect(read.doc.nodes[0]).toMatchObject({ id: 'a', status: 'running', agent: 'child' });
    expect(read.doc.revision).toBe(2);
  });

  it('never creates a node, and skips a node that already has an agent', async () => {
    await seedNode('root', { id: 'a', label: '总①', title: 't', phase: 'exec', status: 'running', agent: 'other' });
    const lifecycleEvents = lifecycle('root');
    const before = readFileSync(dagFilePath('root', dir), 'utf8');
    lifecycleEvents.start({ runId: 'r1', id: 'child' });
    await tick();
    expect(readFileSync(dagFilePath('root', dir), 'utf8')).toBe(before);

    // A session with no DAG at all stays that way — the listener must not
    // invent one for a child it knows nothing about.
    const empty = lifecycle('lonely');
    empty.start({ runId: 'r2', id: 'child' });
    await tick();
    expect((await readDag('lonely', dir)).state).toBe('missing');
  });

  it('settles a paired node as failed with the stop reason and last message', async () => {
    await seedNode('root', { id: 'a', label: '总①', title: 't', phase: 'exec', status: 'running', agent: 'child' });
    const lifecycleEvents = lifecycle('root');
    lifecycleEvents.start({ runId: 'r1', id: 'child' });
    lifecycleEvents.end({
      runId: 'r1',
      id: 'child',
      stopReason: 'error',
      lastAssistantMessage: [
        { type: 'text', text: '第一条' },
        { type: 'tool_use', id: 'x' },
        { type: 'text', text: '最后结论' },
      ],
    });
    await tick();
    const read = await readDag('root', dir);
    expect(read.state).toBe('ok');
    if (read.state !== 'ok') return;
    expect(read.doc.nodes[0]).toMatchObject({
      status: 'done',
      verdict: 'fail',
      agent: 'child',
      note: 'error\n第一条\n最后结论',
    });
  });

  it('names a silent end and leaves an already-settled node alone', async () => {
    await seedNode('root', { id: 'a', label: '总①', title: 't', phase: 'exec', status: 'running', agent: 'child' });
    const lifecycleEvents = lifecycle('root');
    lifecycleEvents.end({ runId: 'unknown-run', id: 'child' });
    await tick();
    const read = await readDag('root', dir);
    expect(read.state).toBe('ok');
    if (read.state !== 'ok') return;
    expect(read.doc.nodes[0]).toMatchObject({ verdict: 'fail' });
    expect(String((read.doc.nodes[0] ?? {}).note)).toContain('subagent ended without a verdict');

    // The child's own `set` is the better record: a settled node is untouched.
    const settled = await updateDag(
      'root',
      (state) => {
        if (state.state !== 'ok') return { skip: true };
        return { doc: { ...state.doc, revision: state.doc.revision + 1 } };
      },
      dir
    );
    expect(settled.ok).toBe(true);
    const revision = settled.ok && !('skipped' in settled) ? settled.doc.revision : 0;
    lifecycleEvents.end({ runId: 'r1', id: 'child', stopReason: 'error' });
    await tick();
    const after = await readDag('root', dir);
    expect(after.state).toBe('ok');
    if (after.state !== 'ok') return;
    expect(after.doc.revision).toBe(revision);
  });
});

/**
 * The worktree actions (#172) end to end: the tool drives the production git
 * runner against a real temporary repository and persists the outcome on the
 * node. The domain cycle itself is covered in `dag-worktree.test.ts`; these cases
 * are about the tool's contract — what lands in the document, what the answer
 * says, and which refusals reach the model.
 */
describe('executeDagTool: wt / merge (#172)', () => {
  let repo: string;

  /** Commit a file in `cwd` so a branch has something to merge. */
  function commit(cwd: string, name: string, text: string, message: string): void {
    writeFileSync(join(cwd, name), text);
    execFileSync('git', ['add', '--', name], { cwd });
    execFileSync(
      'git',
      ['-c', 'user.name=t', '-c', 'user.email=t@e.i', 'commit', '-q', '-m', message],
      { cwd }
    );
  }

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'dsh-mint-dag-wt-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    commit(repo, 'README.md', '# fixture\n', 'init');
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  /** A DAG with one node, so the worktree actions have something to hang on. */
  async function seedGraph(): Promise<void> {
    expect((await run(SESSION, { action: 'init', title: 'wt' })).ok).toBe(true);
    const added = await run(SESSION, {
      action: 'add',
      nodes: [{ id: 'a1', label: '①', title: 'work', phase: 'exec', issue: 172 }],
    });
    expect(added.ok).toBe(true);
  }

  /** The node as the stored document currently has it. */
  async function node(): Promise<DagNodeView | undefined> {
    const read = await readDag(SESSION, dir);
    return read.state === 'ok' ? read.doc.nodes[0] : undefined;
  }

  it('creates a worktree and records it on the node', async () => {
    await seedGraph();
    const outcome = await runWorktree(repo, { action: 'wt', op: 'create', node: 'a1' });
    expect(outcome.ok).toBe(true);
    expect(outcome.summary).toContain('[plan-dag] wt a1 active');
    expect(outcome.summary).toContain(`dsh-mint/wt/${SESSION}/a1`);

    const stored = await node();
    expect(stored?.worktree?.state).toBe('active');
    expect(stored?.worktree?.path).toContain(join(repo, '.worktrees'));
    expect(stored?.worktree?.base).toMatch(/^[0-9a-f]{40}$/);
  });

  it('is idempotent and reports the existing worktree', async () => {
    await seedGraph();
    const first = await runWorktree(repo, { action: 'wt', op: 'create', node: 'a1' });
    const again = await runWorktree(repo, { action: 'wt', op: 'create', node: 'a1' });
    expect(again.ok).toBe(true);
    expect(again.summary).toContain('已存在');
    expect(first.summary).toBeDefined();
  });

  it('refuses an unknown node and a bad op before touching git', async () => {
    await seedGraph();
    const unknown = await runWorktree(repo, { action: 'wt', op: 'create', node: 'nope' });
    expect(unknown.ok).toBe(false);
    expect(unknown.summary).toContain('节点不存在');

    const badOp = await runWorktree(repo, { action: 'wt', op: 'clone', node: 'a1' });
    expect(badOp.ok).toBe(false);
    expect(badOp.summary).toContain('op=');
  });

  it('refuses wt/merge without a graph, and without a repository root', async () => {
    const noGraph = await runWorktree(repo, { action: 'wt', op: 'list' });
    expect(noGraph.ok).toBe(false);
    expect(noGraph.summary).toContain('暂无 DAG');

    await seedGraph();
    const noRepo = await executeDagTool({ sessionId: SESSION, dagDir: dir }, { action: 'wt', op: 'list' });
    expect(noRepo.ok).toBe(false);
    expect(noRepo.summary).toContain('仓库根目录');
  });

  it('merges a node branch, records the state and reports the main-branch sha', async () => {
    await seedGraph();
    const created = await runWorktree(repo, { action: 'wt', op: 'create', node: 'a1' });
    expect(created.ok).toBe(true);
    const stored = await node();
    const tree = stored?.worktree?.path;
    expect(tree).toBeDefined();
    if (tree === undefined) return;
    commit(tree, 'feature.txt', 'work\n', 'work #172');

    const merged = await runWorktree(repo, { action: 'merge', node: 'a1' });
    expect(merged.ok).toBe(true);
    expect(merged.summary).toContain('wt a1 merged');
    expect(merged.summary).toContain('主分支');

    const after = await node();
    expect(after?.worktree?.state).toBe('merged');
    expect(after?.worktree?.merged_sha).toMatch(/^[0-9a-f]{7,}$/);
    expect(execFileSync('git', ['show', 'HEAD:feature.txt'], { cwd: repo, encoding: 'utf8' })).toContain('work');
  });

  it('lists the session worktrees and removes a merged one', async () => {
    await seedGraph();
    const created = await runWorktree(repo, { action: 'wt', op: 'create', node: 'a1' });
    expect(created.ok).toBe(true);
    const list = await runWorktree(repo, { action: 'wt', op: 'list' });
    expect(list.ok).toBe(true);
    expect(list.summary).toContain('a1 active');

    const tree = (await node())?.worktree?.path;
    if (tree === undefined) return;
    commit(tree, 'feature.txt', 'work\n', 'work #172');
    expect((await runWorktree(repo, { action: 'merge', node: 'a1' })).ok).toBe(true);

    const removed = await runWorktree(repo, { action: 'wt', op: 'remove', node: 'a1' });
    expect(removed.ok).toBe(true);
    expect(removed.summary).toContain('a1 removed');
    expect((await node())?.worktree?.state).toBe('removed');
  });

  it('refuses to remove an unmerged worktree without force', async () => {
    await seedGraph();
    const created = await runWorktree(repo, { action: 'wt', op: 'create', node: 'a1' });
    expect(created.ok).toBe(true);
    const tree = (await node())?.worktree?.path;
    if (tree === undefined) return;
    commit(tree, 'feature.txt', 'work\n', 'work #172');

    const refused = await runWorktree(repo, { action: 'wt', op: 'remove', node: 'a1' });
    expect(refused.ok).toBe(false);
    expect(refused.summary).toContain('尚未合并');

    const forced = await runWorktree(repo, { action: 'wt', op: 'remove', node: 'a1', force: true });
    expect(forced.ok).toBe(true);
  });
});
