import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { dagFilePath, readDag, updateDag } from './dag-store.js';
import type { DagNodeView } from './records.js';
import { installDagLifecycle } from './dag-lifecycle.js';
import {
  DAG_TOOL_DESCRIPTION,
  TOOL_NAME,
  executeDagTool,
  installDagTool,
  rootSessionId,
} from './dag-tool.js';
import type { DagToolOutcome } from './dag-tool.js';
import type { AgentCwdLike, AgentsLike, DshContext, ToolDefinitionLike } from './types.js';

/**
 * The `mint_plan_dag` surface (plan #31).
 *
 * Every case runs against a **temporary directory**: the shipped default is
 * `/tmp/mint/dag`, and a test that wrote there would delete a real session's
 * graph (or, worse, pass because of one).
 */
let dir: string;

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
        action: { type: 'string', enum: ['init', 'add', 'set', 'get'] },
        status: { type: 'string', enum: ['pending', 'running', 'done'] },
        verdict: { type: 'string', enum: ['pass', 'fail'] },
        tokens: { type: 'integer' },
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
