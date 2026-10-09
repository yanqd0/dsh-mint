import { describe, expect, it } from 'vitest';

import {
  dagCounts,
  dagLayers,
  dagSummary,
  findCycle,
  unknownDependencies,
} from '../../../../../src/dag/dag.js';
import { doc, node } from './helpers.js';

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
