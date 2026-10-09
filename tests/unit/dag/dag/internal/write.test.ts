import { describe, expect, it } from 'vitest';

import { DAG_NODE_MAX, applyDagWrite, emptyDag } from '../../../../../src/dag/dag.js';
import { NOW, SESSION, doc, errorOf, node } from './helpers.js';

describe('applyDagWrite', () => {
  it('init replaces whatever was there with a fresh document', () => {
    const previous = doc({ nodes: [node()], revision: 9 });
    const result = applyDagWrite({ action: 'init', title: '演示计划' }, previous, SESSION, NOW);
    expect(result).toEqual({ doc: emptyDag(SESSION, '演示计划', NOW) });
    expect(emptyDag(SESSION, '演示计划', NOW)).toMatchObject({
      version: 1,
      session: SESSION,
      title: '演示计划',
      revision: 1,
      created_at: NOW,
      nodes: [],
      edges: [],
    });
  });

  // 无文档时的门禁：`add`/`set` 必须先 `init`，错误文案要给出可直接照做的下一步。
  // 传 `undefined` 当作文档，断言 add 返回完整文案、set 也含「暂无 DAG」。
  it('refuses add/set when the session has no document yet', () => {
    expect(applyDagWrite({ action: 'add', nodes: [], edges: [] }, undefined, SESSION, NOW)).toEqual({
      error: '本会话暂无 DAG；先用 action="init" 建立，再 add/set',
    });
    expect(errorOf(applyDagWrite({ action: 'set', id: 'a', status: 'running' }, undefined, SESSION, NOW))).toContain(
      '暂无 DAG'
    );
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

  // 写入前的三道校验：重复 id、未知依赖（含边指向）与成环（含自环、纯边闭环）都必须拒绝。
  // 同一用例依次喂三种坏输入，断言错误文案分别点名「已存在」、排序后的未知依赖与「成环」。
  it('rejects an add whose ids already exist or whose graph is broken', () => {
    const current = doc({ nodes: [node({ id: 'a' })] });
    expect(
      applyDagWrite(
        { action: 'add', nodes: [{ id: 'a', label: 'l', title: 't', phase: 'exec', depends_on: [] }], edges: [] },
        current,
        SESSION,
        NOW
      )
    ).toEqual({ error: '节点 id 已存在：a' });
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
    expect(errorOf(cycle)).toContain('成环');

    // A self-loop is a cycle too, and an edge can close one without depends_on.
    const selfLoop = applyDagWrite(
      { action: 'add', nodes: [{ id: 'b', label: 'b', title: 'b', phase: 'exec', depends_on: ['b'] }], edges: [] },
      current,
      SESSION,
      NOW
    );
    expect(errorOf(selfLoop)).toContain('成环');
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
    expect(errorOf(edgeCycle)).toContain('成环');
  });

  // 规模上限：节点数到顶后再 add 必须拒绝，且同时报出上限与当前值。
  // 用 `DAG_NODE_MAX` 条夹具节点铺满文档，再塞一个 extra，断言完整错误文案。
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
