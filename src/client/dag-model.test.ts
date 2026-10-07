import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { DagNodeView, DagView } from '../records.js';
import {
  DAG_H_GAP,
  DAG_NODE_H,
  DAG_NODE_W,
  DAG_PAD,
  DAG_V_GAP,
  dagCounts,
  dagTone,
  isRunning,
  layoutDag,
} from './dag-model.js';
import type { DagLayout } from './dag-model.js';

/** One node with the defaults a test does not care about spelled out. */
function node(id: string, extra: Partial<DagNodeView> = {}): DagNodeView {
  return {
    id,
    label: id,
    title: `${id} title`,
    phase: 'exec',
    status: 'pending',
    depends_on: [],
    updated_at: '2026-01-01T00:00:00Z',
    ...extra,
  };
}

/** A document over the given nodes; edges are the second way to state deps. */
function view(nodes: DagNodeView[], edges: [string, string][] = []): DagView {
  return {
    title: 'plan',
    revision: 1,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    nodes,
    edges,
  };
}

/** The box `id` was laid out at, or a failure when it has none. */
function box(layout: DagLayout, id: string): { x: number; y: number; w: number; h: number } {
  const found = layout.boxes.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`no box for ${id}`);
  return found;
}

describe('dagTone', () => {
  // The four states of the spec, on the axis the theme tokens live on.
  it('maps the four states onto the three theme tones', () => {
    expect(dagTone(node('a', { status: 'pending' }))).toBe('warn');
    expect(dagTone(node('a', { status: 'running' }))).toBe('success');
    expect(dagTone(node('a', { status: 'done', verdict: 'pass' }))).toBe('success');
    expect(dagTone(node('a', { status: 'done', verdict: 'fail' }))).toBe('error');
  });

  // A half-written document (settled, no verdict) is not a failure; drawing it
  // red would report an outcome the host never recorded.
  it('treats a settled node without a verdict as a success', () => {
    expect(dagTone(node('a', { status: 'done' }))).toBe('success');
  });

  it('reserves the pulse for the one in-flight status', () => {
    expect(isRunning(node('a', { status: 'running' }))).toBe(true);
    for (const status of ['pending', 'done'] as const) {
      expect(isRunning(node('a', { status }))).toBe(false);
    }
  });
});

describe('layoutDag', () => {
  it('draws a chain top-down, one node per layer', () => {
    const layout = layoutDag(
      view([node('a'), node('b', { depends_on: ['a'] }), node('c', { depends_on: ['b'] })])
    );
    expect(layout.boxes.map((b) => b.id)).toEqual(['a', 'b', 'c']);
    for (const [index, id] of ['a', 'b', 'c'].entries()) {
      expect(box(layout, id).y).toBe(DAG_PAD + index * (DAG_NODE_H + DAG_V_GAP));
    }
    expect(layout.edges.map((e) => [e.from, e.to])).toEqual([
      ['a', 'b'],
      ['b', 'c'],
    ]);
  });

  it('puts a diamond together in its middle layer and centers it', () => {
    const layout = layoutDag(
      view([
        node('a'),
        node('b', { depends_on: ['a'] }),
        node('c', { depends_on: ['a'] }),
        node('d', { depends_on: ['b', 'c'] }),
      ])
    );
    const middle = [box(layout, 'b'), box(layout, 'c')];
    expect(middle[0]?.y).toBe(middle[1]?.y);
    expect(middle[1]?.x).toBe((middle[0]?.x ?? 0) + DAG_NODE_W + DAG_H_GAP);
    expect(box(layout, 'd').y).toBe(DAG_PAD + 2 * (DAG_NODE_H + DAG_V_GAP));
    // A single-node layer is centered over the two-node one.
    const center = (b: { x: number; w: number }): number => b.x + b.w / 2;
    expect(center(box(layout, 'a'))).toBe(center(box(layout, 'd')));
    expect(layout.width).toBe(DAG_PAD * 2 + 2 * DAG_NODE_W + DAG_H_GAP);
    expect(layout.height).toBe(DAG_PAD * 2 + 3 * DAG_NODE_H + 2 * DAG_V_GAP);
  });

  it('places a node below its deepest dependency, not its first', () => {
    const layout = layoutDag(
      view([node('a'), node('b'), node('a1', { depends_on: ['a'] }), node('z', { depends_on: ['a1', 'b'] })])
    );
    expect(box(layout, 'a1').y).toBe(DAG_PAD + DAG_NODE_H + DAG_V_GAP);
    expect(box(layout, 'z').y).toBe(DAG_PAD + 2 * (DAG_NODE_H + DAG_V_GAP));
  });

  it('reads `edges` as the same relation as `depends_on`, without duplicating', () => {
    const layout = layoutDag(view([node('a'), node('b', { depends_on: ['a'] })], [['a', 'b']]));
    expect(layout.edges).toHaveLength(1);
    expect(layout.edges[0]?.points).toBe('64,46 64,69 64,92');
  });

  it('draws an elbow from the parent bottom-center to the child top-center', () => {
    const layout = layoutDag(view([node('a'), node('b', { depends_on: ['a'] })]));
    const [edge] = layout.edges;
    const parent = box(layout, 'a');
    const child = box(layout, 'b');
    const y1 = parent.y + parent.h;
    const y2 = child.y;
    const x = parent.x + parent.w / 2;
    const midY = (y1 + y2) / 2;
    expect(edge?.points).toBe(`${String(x)},${String(y1)} ${String(x)},${String(midY)} ${String(x)},${String(y2)}`);
  });

  it('is deterministic: the same view draws the same picture', () => {
    const doc = view(
      [node('a'), node('b', { depends_on: ['a'] }), node('c', { depends_on: ['a'] })],
      [['b', 'c']]
    );
    expect(layoutDag(doc)).toEqual(layoutDag(doc));
  });

  it('keeps the input order inside one layer', () => {
    const layout = layoutDag(
      view([
        node('c'),
        node('b', { depends_on: ['c'] }),
        node('a', { depends_on: ['b'] }),
      ])
    );
    expect(layout.boxes.map((b) => b.id)).toEqual(['c', 'b', 'a']);
  });

  it('gives an empty document a minimal frame instead of a zero-size one', () => {
    const layout = layoutDag(view([]));
    expect(layout.boxes).toEqual([]);
    expect(layout.edges).toEqual([]);
    expect(layout.width).toBe(DAG_PAD * 2 + DAG_NODE_W);
    expect(layout.height).toBe(DAG_PAD * 2);
  });

  // The tool refuses to store a cycle, but the panel reads a file it did not
  // write; a hand-edited document must render a wrong picture, not crash. The
  // back edge contributes nothing to the depth, so both nodes still get a row.
  it('survives a cycle instead of recursing forever', () => {
    const layout = layoutDag(
      view([node('a', { depends_on: ['b'] }), node('b', { depends_on: ['a'] })])
    );
    expect(layout.boxes).toHaveLength(2);
    expect(layout.edges).toHaveLength(2);
  });

  it('ignores references to unknown ids on both sides of an edge', () => {
    const layout = layoutDag(
      view([node('a', { depends_on: ['ghost'] }), node('b')], [['ghost', 'b'], ['a', 'nobody']])
    );
    expect(layout.boxes.map((b) => b.id)).toEqual(['a', 'b']);
    expect(layout.edges).toEqual([]);
  });

  it('keeps every box inside the reported canvas', () => {
    const layout = layoutDag(view([node('a'), node('b', { depends_on: ['a'] })]));
    for (const item of layout.boxes) {
      expect(item.x).toBeGreaterThanOrEqual(DAG_PAD);
      expect(item.y).toBeGreaterThanOrEqual(DAG_PAD);
      expect(item.x + item.w).toBeLessThanOrEqual(layout.width - DAG_PAD);
      expect(item.y + item.h).toBeLessThanOrEqual(layout.height - DAG_PAD);
    }
  });
});

describe('dagCounts', () => {
  it('counts nodes, edges, and each status', () => {
    const doc = view([
      node('a', { status: 'done', verdict: 'pass' }),
      node('b', { status: 'running' }),
      node('c'),
      node('d'),
    ]);
    doc.edges = [['a', 'b']];
    expect(dagCounts(doc)).toEqual({ nodes: 4, edges: 1, pending: 2, running: 1, done: 1 });
  });

  it('counts an empty document as all zeroes', () => {
    expect(dagCounts(view([]))).toEqual({ nodes: 0, edges: 0, pending: 0, running: 0, done: 0 });
  });
});

// The animation is a class the component sets and a keyframe it injects; both
// live in a `.tsx` file no Node test can import, so the guard reads the source.
describe('DAG animation contract', () => {
  it('defines the keyframes and the reduced-motion opt-out the node class needs', () => {
    const source = readFileSync(fileURLToPath(new URL('DagBody.tsx', import.meta.url)), 'utf8');
    expect(source).toContain('@keyframes dsh-mint-dag-pulse');
    expect(source).toContain('prefers-reduced-motion: reduce');
    expect(source).toContain('animation: none');
    // One `running` class, and it is the animation's target.
    expect(source).toContain('DAG_RUNNING_CLASS');
  });
});
