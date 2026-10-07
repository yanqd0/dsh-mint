import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  DAG_LABEL_MAX,
  DAG_NODE_MAX,
  DAG_NOTE_MAX,
  applyDagWrite,
  dagCounts,
  dagLayers,
  dagSummary,
  emptyDag,
  findCycle,
  isValidDagSession,
  parseDagAction,
  parseDagDoc,
  unknownDependencies,
} from './dag.js';
import type { DagAddNode, DagDoc, DagNode } from './dag.js';

const NOW = '2026-10-07T00:00:00.000Z';
const SESSION = 'session-1';

/** One stored node; every field a case does not care about is filled here. */
function node(over: Partial<DagNode> = {}): DagNode {
  return {
    id: 'a',
    label: '总①',
    title: '第一轮',
    phase: 'exec',
    status: 'pending',
    depends_on: [],
    updated_at: NOW,
    ...over,
  };
}

/** One stored document. */
function doc(over: Partial<DagDoc> = {}): DagDoc {
  return {
    version: 1,
    session: SESSION,
    title: '',
    revision: 1,
    created_at: NOW,
    updated_at: NOW,
    nodes: [],
    edges: [],
    ...over,
  };
}

/** One `add` entry. */
function addNode(over: Partial<DagAddNode> = {}): Partial<DagAddNode> {
  return { id: 'a', label: '总①', title: '第一轮', phase: 'exec', ...over };
}

/** The error text of a refused outcome, failing loudly on an unexpected success. */
function errorOf(result: ReturnType<typeof parseDagAction>): string {
  if (!('error' in result)) throw new Error(`expected a refusal, got ${JSON.stringify(result)}`);
  return result.error;
}

describe('isValidDagSession', () => {
  it('accepts the ids the host hands out and the ones a URL can carry', () => {
    for (const id of ['a', 'A-1', 'sess_01', 'x'.repeat(64)]) {
      expect(isValidDagSession(id), id).toBe(true);
    }
  });

  it('refuses anything that could escape the directory or is not an id', () => {
    for (const id of ['', 'a/b', '..', '../x', 'a.b', 'a b', 'a\nb', 'é', 'x'.repeat(65)]) {
      expect(isValidDagSession(id), JSON.stringify(id)).toBe(false);
    }
  });
});

describe('parseDagAction', () => {
  it('refuses arguments that are not an object or carry no known action', () => {
    expect(errorOf(parseDagAction(undefined))).toContain('对象');
    expect(errorOf(parseDagAction('init'))).toContain('对象');
    expect(errorOf(parseDagAction({}))).toContain('action');
    expect(errorOf(parseDagAction({ action: 'draw' }))).toContain('action');
  });

  it('reads get as a pure read', () => {
    expect(parseDagAction({ action: 'get' })).toEqual({ action: 'get' });
  });

  it('allows init without a title and bounds the one it takes', () => {
    expect(parseDagAction({ action: 'init' })).toEqual({ action: 'init', title: '' });
    expect(parseDagAction({ action: 'init', title: '第 31 号计划' })).toEqual({
      action: 'init',
      title: '第 31 号计划',
    });
    expect(errorOf(parseDagAction({ action: 'init', title: 7 }))).toContain('title');
    expect(errorOf(parseDagAction({ action: 'init', title: 'x'.repeat(201) }))).toContain('title');
  });

  it('requires a non-empty node list for add', () => {
    expect(errorOf(parseDagAction({ action: 'add' }))).toContain('nodes');
    expect(errorOf(parseDagAction({ action: 'add', nodes: [] }))).toContain('nodes');
    expect(errorOf(parseDagAction({ action: 'add', nodes: 'a' }))).toContain('nodes');
  });

  it('checks every node field add carries', () => {
    const good = parseDagAction({
      action: 'add',
      nodes: [
        addNode({ id: 'a' }),
        addNode({ id: 'b', depends_on: ['a', 'a'], issue: 31, phase: 'research' }),
      ],
      edges: [['a', 'b']],
    });
    expect(good).toEqual({
      action: 'add',
      nodes: [
        { id: 'a', label: '总①', title: '第一轮', phase: 'exec', depends_on: [] },
        { id: 'b', label: '总①', title: '第一轮', phase: 'research', depends_on: ['a'], issue: 31 },
      ],
      edges: [['a', 'b']],
    });

    expect(errorOf(parseDagAction({ action: 'add', nodes: ['x'] }))).toContain('对象');
    expect(errorOf(parseDagAction({ action: 'add', nodes: [addNode({ id: '' })] }))).toContain('id');
    expect(errorOf(parseDagAction({ action: 'add', nodes: [addNode({ id: 'x'.repeat(65) })] }))).toContain('id');
    expect(errorOf(parseDagAction({ action: 'add', nodes: [addNode({ id: 'a\u0000' })] }))).toContain('控制字符');
    expect(errorOf(parseDagAction({ action: 'add', nodes: [addNode({ label: '' })] }))).toContain('label');
    expect(
      errorOf(parseDagAction({ action: 'add', nodes: [addNode({ label: 'x'.repeat(DAG_LABEL_MAX + 1) })] }))
    ).toContain('label');
    expect(errorOf(parseDagAction({ action: 'add', nodes: [addNode({ label: 'a\u0007' })] }))).toContain('控制字符');
    expect(parseDagAction({ action: 'add', nodes: [addNode({ label: '123456' })] })).toMatchObject({
      action: 'add',
    });
    expect(errorOf(parseDagAction({ action: 'add', nodes: [addNode({ title: '' })] }))).toContain('title');
    expect(errorOf(parseDagAction({ action: 'add', nodes: [addNode({ title: 'x'.repeat(201) })] }))).toContain('title');
    expect(errorOf(parseDagAction({ action: 'add', nodes: [addNode({ phase: 'plan' as never })] }))).toContain('phase');
    expect(
      errorOf(parseDagAction({ action: 'add', nodes: [addNode({ depends_on: 'a' as never })] }))
    ).toContain('depends_on');
    expect(
      errorOf(parseDagAction({ action: 'add', nodes: [addNode({ depends_on: [''] })] }))
    ).toContain('depends_on');
    expect(errorOf(parseDagAction({ action: 'add', nodes: [addNode({ issue: 1.5 })] }))).toContain('issue');
    expect(errorOf(parseDagAction({ action: 'add', nodes: [addNode({ id: 'a' }), addNode({ id: 'a' })] }))).toContain(
      '重复'
    );
    expect(errorOf(parseDagAction({ action: 'add', nodes: [addNode()], edges: 'x' as never }))).toContain('edges');
    expect(errorOf(parseDagAction({ action: 'add', nodes: [addNode()], edges: [['a'] as never] }))).toContain(
      'edges'
    );
    expect(errorOf(parseDagAction({ action: 'add', nodes: [addNode()], edges: [[1, 2] as never] }))).toContain(
      'edges'
    );
  });

  it('checks every field set carries', () => {
    expect(parseDagAction({ action: 'set', id: 'a', status: 'running' })).toEqual({
      action: 'set',
      id: 'a',
      status: 'running',
    });
    expect(
      parseDagAction({ action: 'set', id: 'a', status: 'done', verdict: 'pass', note: 'ok', tokens: 12, agent: 's-2' })
    ).toEqual({
      action: 'set',
      id: 'a',
      status: 'done',
      verdict: 'pass',
      note: 'ok',
      tokens: 12,
      agent: 's-2',
    });

    expect(errorOf(parseDagAction({ action: 'set', status: 'running' }))).toContain('id');
    expect(errorOf(parseDagAction({ action: 'set', id: 'a', status: 'shipped' }))).toContain('status');
    expect(errorOf(parseDagAction({ action: 'set', id: 'a', status: 'running', verdict: 'pass' }))).toContain(
      'verdict'
    );
    expect(errorOf(parseDagAction({ action: 'set', id: 'a', status: 'done', verdict: 'maybe' }))).toContain('verdict');
    expect(errorOf(parseDagAction({ action: 'set', id: 'a', status: 'done', note: 7 as never }))).toContain('note');
    expect(
      errorOf(parseDagAction({ action: 'set', id: 'a', status: 'done', note: 'x'.repeat(DAG_NOTE_MAX + 1) }))
    ).toContain('note');
    expect(errorOf(parseDagAction({ action: 'set', id: 'a', status: 'done', tokens: -1 }))).toContain('tokens');
    expect(errorOf(parseDagAction({ action: 'set', id: 'a', status: 'done', tokens: 1.5 }))).toContain('tokens');
    expect(errorOf(parseDagAction({ action: 'set', id: 'a', status: 'done', agent: '' }))).toContain('agent');
    expect(errorOf(parseDagAction({ action: 'set', id: 'a', status: 'done', agent: 'x'.repeat(129) }))).toContain(
      'agent'
    );
  });
});

describe('applyDagWrite', () => {
  it('init replaces whatever was there with a fresh document', () => {
    const previous = doc({ nodes: [node()], revision: 9 });
    const result = applyDagWrite({ action: 'init', title: 'plan 31' }, previous, SESSION, NOW);
    expect(result).toEqual({ doc: emptyDag(SESSION, 'plan 31', NOW) });
    expect(emptyDag(SESSION, 'plan 31', NOW)).toMatchObject({
      version: 1,
      session: SESSION,
      title: 'plan 31',
      revision: 1,
      created_at: NOW,
      nodes: [],
      edges: [],
    });
  });

  it('refuses add/set when the session has no document yet', () => {
    expect(applyDagWrite({ action: 'add', nodes: [], edges: [] }, undefined, SESSION, NOW)).toEqual({
      error: '本会话暂无 DAG；先用 action="init" 建立，再 add/set',
    });
    const noDocument = applyDagWrite({ action: 'set', id: 'a', status: 'running' }, undefined, SESSION, NOW);
    if (!('error' in noDocument)) throw new Error('expected a refusal');
    expect(noDocument.error).toContain('暂无 DAG');
  });

  it('appends nodes and edges and advances the revision', () => {
    const current = doc({ nodes: [node({ id: 'a' })] });
    const result = applyDagWrite(
      {
        action: 'add',
        nodes: [
          { id: 'b', label: '分①', title: '跑子代理', phase: 'research', depends_on: ['a'] },
          { id: 'c', label: '总②', title: '汇合', phase: 'exec', depends_on: [], issue: 150 },
        ],
        edges: [['b', 'c']],
      },
      current,
      SESSION,
      NOW
    );
    if ('error' in result) throw new Error(result.error);
    expect(result.doc.revision).toBe(2);
    expect(result.doc.updated_at).toBe(NOW);
    expect(result.doc.nodes.map((entry) => [entry.id, entry.status])).toEqual([
      ['a', 'pending'],
      ['b', 'pending'],
      ['c', 'pending'],
    ]);
    expect(result.doc.nodes[1]?.depends_on).toEqual(['a']);
    expect(result.doc.nodes[2]?.issue).toBe(150);
    expect(result.doc.edges).toEqual([['b', 'c']]);
    // The input document is never mutated in place.
    expect(current.nodes).toHaveLength(1);
  });

  it('rejects an add whose ids already exist or whose graph is broken', () => {
    const current = doc({ nodes: [node({ id: 'a' })] });
    expect(applyDagWrite({ action: 'add', nodes: [{ id: 'a', label: 'l', title: 't', phase: 'exec', depends_on: [] }], edges: [] }, current, SESSION, NOW)).toEqual({ error: '节点 id 已存在：a' });
    expect(
      applyDagWrite(
        {
          action: 'add',
          nodes: [
            { id: 'b', label: 'b', title: 'b', phase: 'exec', depends_on: ['ghost', 'phantom'] },
            { id: 'c', label: 'c', title: 'c', phase: 'exec', depends_on: [] },
          ],
          edges: [['a', 'nope']],
        },
        current,
        SESSION,
        NOW
      )
    ).toEqual({ error: '未知依赖（没有对应节点）：ghost, nope, phantom' });

    const cycle = applyDagWrite(
      {
        action: 'add',
        nodes: [
          { id: 'b', label: 'b', title: 'b', phase: 'exec', depends_on: ['c'] },
          { id: 'c', label: 'c', title: 'c', phase: 'exec', depends_on: ['b'] },
        ],
        edges: [],
      },
      current,
      SESSION,
      NOW
    );
    if (!('error' in cycle)) throw new Error('expected a refusal');
    expect(cycle.error).toContain('成环');

    // A self-loop is a cycle too, and an edge can close one without depends_on.
    const selfLoop = applyDagWrite(
      { action: 'add', nodes: [{ id: 'b', label: 'b', title: 'b', phase: 'exec', depends_on: ['b'] }], edges: [] },
      current,
      SESSION,
      NOW
    );
    if (!('error' in selfLoop)) throw new Error('expected a refusal');
    expect(selfLoop.error).toContain('成环');
    const edgeCycle = applyDagWrite(
      {
        action: 'add',
        nodes: [{ id: 'b', label: 'b', title: 'b', phase: 'exec', depends_on: [] }],
        edges: [
          ['b', 'a'],
          ['a', 'b'],
        ],
      },
      current,
      SESSION,
      NOW
    );
    if (!('error' in edgeCycle)) throw new Error('expected a refusal');
    expect(edgeCycle.error).toContain('成环');
  });

  it('bounds the document at the node ceiling', () => {
    const nodes = Array.from({ length: DAG_NODE_MAX }, (_, index) => node({ id: `n${String(index)}` }));
    const full = doc({ nodes });
    expect(
      applyDagWrite(
        { action: 'add', nodes: [{ id: 'extra', label: 'x', title: 'x', phase: 'exec', depends_on: [] }], edges: [] },
        full,
        SESSION,
        NOW
      )
    ).toEqual({ error: `节点数超过上限 ${String(DAG_NODE_MAX)}（当前 ${String(DAG_NODE_MAX)}）` });
  });

  it('updates one node and keeps verdict and lifecycle consistent', () => {
    const current = doc({
      nodes: [node({ id: 'a', status: 'pending' }), node({ id: 'b', depends_on: ['a'] })],
    });
    const running = applyDagWrite({ action: 'set', id: 'b', status: 'running', agent: 'child-1' }, current, SESSION, NOW);
    if ('error' in running) throw new Error(running.error);
    expect(running.doc.nodes[1]).toMatchObject({ status: 'running', agent: 'child-1', updated_at: NOW });
    expect(running.doc.revision).toBe(2);

    const settled = applyDagWrite(
      { action: 'set', id: 'b', status: 'done', verdict: 'pass', note: '结论', tokens: 42 },
      running.doc,
      SESSION,
      NOW
    );
    if ('error' in settled) throw new Error(settled.error);
    expect(settled.doc.nodes[1]).toMatchObject({
      status: 'done',
      verdict: 'pass',
      note: '结论',
      tokens: 42,
      agent: 'child-1',
    });

    // Re-opening a settled node drops the outcome: a running node has no verdict.
    const reopened = applyDagWrite({ action: 'set', id: 'b', status: 'running' }, settled.doc, SESSION, NOW);
    if ('error' in reopened) throw new Error(reopened.error);
    expect(reopened.doc.nodes[1]?.verdict).toBeUndefined();

    const failed = applyDagWrite({ action: 'set', id: 'b', status: 'done', verdict: 'fail' }, reopened.doc, SESSION, NOW);
    if ('error' in failed) throw new Error(failed.error);
    expect(failed.doc.nodes[1]?.verdict).toBe('fail');

    expect(applyDagWrite({ action: 'set', id: 'zzz', status: 'done' }, current, SESSION, NOW)).toEqual({
      error: '节点不存在：zzz',
    });
  });
});

describe('graph helpers', () => {
  it('lists every unknown dependency once, sorted', () => {
    const nodes = [node({ id: 'a', depends_on: ['z'] }), node({ id: 'b', depends_on: [] })];
    expect(unknownDependencies(nodes, [['a', 'missing'], ['ghost', 'a'], ['z', 'z']])).toEqual(['ghost', 'missing', 'z']);
    expect(unknownDependencies(nodes, [])).toEqual(['z']);
    expect(unknownDependencies([node({ id: 'a', depends_on: [] })], [])).toEqual([]);
  });

  it('finds one cycle and reports none for a DAG', () => {
    expect(findCycle([node({ id: 'a' }), node({ id: 'b', depends_on: ['a'] })], [])).toBeUndefined();
    const cycle = findCycle(
      [node({ id: 'a' }), node({ id: 'b', depends_on: ['a'] }), node({ id: 'c', depends_on: ['b'] })],
      [['c', 'a']]
    );
    expect(cycle?.[0]).toBe('a');
    expect(cycle?.at(-1)).toBe('a');
    expect(cycle).toHaveLength(4);
  });

  it('layers a DAG top-down and tolerates a cycle or a dangling reference', () => {
    const nodes = [
      node({ id: 'a' }),
      node({ id: 'b', depends_on: ['a'] }),
      node({ id: 'c', depends_on: ['a'] }),
      node({ id: 'd', depends_on: ['b', 'c', 'ghost'] }),
    ];
    expect(dagLayers(nodes, [])).toEqual([['a'], ['b', 'c'], ['d']]);
    // An edge is a dependency like any other.
    expect(dagLayers([node({ id: 'a' }), node({ id: 'b' })], [['a', 'b']])).toEqual([['a'], ['b']]);
    // A cycle contributes nothing to the depth instead of recursing forever.
    const cyclic = dagLayers([node({ id: 'a', depends_on: ['b'] }), node({ id: 'b', depends_on: ['a'] })], []);
    expect(cyclic.flat().sort()).toEqual(['a', 'b']);
  });

  it('counts nodes by status and renders the one-line summary', () => {
    const subject = doc({
      nodes: [
        node({ id: 'a', label: '总①', status: 'pending' }),
        node({ id: 'b', label: '分①', status: 'running' }),
        node({ id: 'c', label: '总②', status: 'done', verdict: 'pass' }),
      ],
      edges: [['a', 'b']],
    });
    expect(dagCounts(subject)).toEqual({ nodes: 3, edges: 1, pending: 1, running: 1, done: 1 });
    expect(dagCounts(doc())).toEqual({ nodes: 0, edges: 0, pending: 0, running: 0, done: 0 });
    expect(dagSummary(undefined)).toBe('本会话暂无 DAG');
    expect(dagSummary(doc())).toBe('节点 0，边 0：pending 0 / running 0 / done 0');
    expect(dagSummary(subject)).toBe('节点 3，边 1：pending 1 / running 1 / done 1\nrunning: 分①(b)');

    const many = doc({
      nodes: Array.from({ length: 9 }, (_, index) =>
        node({ id: `r${String(index)}`, label: `r${String(index)}`, status: 'running' })
      ),
    });
    expect(dagSummary(many)).toContain('…+1');
  });
});

describe('parseDagDoc', () => {
  it('round-trips a well-formed document', () => {
    const subject = doc({
      nodes: [
        node({ id: 'a', status: 'done', verdict: 'fail', note: 'n', tokens: 3, agent: 'child-1', issue: 150 }),
      ],
      edges: [['a', 'a']],
    });
    const parsed = parseDagDoc(JSON.parse(JSON.stringify(subject)) as unknown);
    expect(parsed).toEqual({ doc: subject });
  });

  it('names what is wrong instead of guessing defaults', () => {
    const cases: [unknown, string][] = [
      [null, 'object'],
      [{ ...doc(), version: 2 }, 'version'],
      [{ ...doc(), session: '../etc' }, 'session'],
      [{ ...doc(), title: 7 }, 'title'],
      [{ ...doc(), revision: -1 }, 'revision'],
      [{ ...doc(), revision: 1.5 }, 'revision'],
      [{ ...doc(), created_at: 7 }, 'created_at'],
      [{ ...doc(), nodes: {} }, 'arrays'],
      [{ ...doc(), nodes: [{ ...node(), phase: 'plan' }] }, 'phase'],
      [{ ...doc(), nodes: [{ ...node(), status: 'shipped' }] }, 'status'],
      [{ ...doc(), nodes: [{ ...node(), verdict: 'maybe' }] }, 'verdict'],
      [{ ...doc(), nodes: [{ ...node(), depends_on: [1] }] }, 'depends_on'],
      [{ ...doc(), nodes: [{ ...node(), updated_at: 7 }] }, 'updated_at'],
      [{ ...doc(), nodes: [{ ...node(), issue: 1.5 }] }, 'issue'],
      [{ ...doc(), nodes: [{ ...node(), tokens: 1.5 }] }, 'tokens'],
      [{ ...doc(), nodes: [{ ...node(), agent: 7 }] }, 'agent'],
      [{ ...doc(), nodes: [{ ...node(), note: 7 }] }, 'note'],
      [{ ...doc(), nodes: [{ ...node(), id: 'a' }, { ...node(), id: 'a' }] }, 'duplicate'],
      [{ ...doc(), nodes: ['x'] }, 'object'],
      [{ ...doc(), edges: [['a']] }, 'edges'],
    ];
    for (const [raw, needle] of cases) {
      const parsed = parseDagDoc(raw);
      if (!('error' in parsed)) throw new Error(`expected a refusal for ${JSON.stringify(raw)}`);
      expect(parsed.error, JSON.stringify(raw)).toContain(needle);
    }
  });
});

describe('dag module boundaries', () => {
  it('imports no node builtin, because the browser bundle inlines it', () => {
    const source = readFileSync(fileURLToPath(new URL('dag.ts', import.meta.url)), 'utf8');
    expect(source).not.toMatch(/from 'node:/);
    expect(source).not.toMatch(/require\('node:/);
    expect(source).not.toMatch(/\bBuffer\./);
  });
});
