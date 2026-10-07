import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { srcPath } from '../../helpers/repo.js';
import type { DagNodeView, DagView } from '../../../src/shared/records.js';
import {
  DAG_COPY_KEYS,
  DAG_H_GAP,
  DAG_NODE_H,
  DAG_NODE_W,
  DAG_PAD,
  DAG_V_GAP,
  dagCounts,
  dagStatusTone,
  dagTone,
  dagWorktreeTone,
  formatCount,
  formatSeconds,
  isRunning,
  layoutDag,
  liveElapsedMs,
  nodeMetricsMap,
} from '../../../src/client/dag-model.js';
import type { DagLayout } from '../../../src/client/dag-model.js';

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
  // The box carries the label and, under it, the measured metric line.
  it('is tall enough for a label and a metrics line', () => {
    expect(DAG_NODE_H).toBe(44);
  });

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
      view([
        node('a'),
        node('b'),
        node('a1', { depends_on: ['a'] }),
        node('z', { depends_on: ['a1', 'b'] }),
      ])
    );
    expect(box(layout, 'a1').y).toBe(DAG_PAD + DAG_NODE_H + DAG_V_GAP);
    expect(box(layout, 'z').y).toBe(DAG_PAD + 2 * (DAG_NODE_H + DAG_V_GAP));
  });

  it('reads `edges` as the same relation as `depends_on`, without duplicating', () => {
    const layout = layoutDag(view([node('a'), node('b', { depends_on: ['a'] })], [['a', 'b']]));
    expect(layout.edges).toHaveLength(1);
    expect(layout.edges[0]?.points).toBe('64,56 64,79 64,102');
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
    expect(edge?.points).toBe(
      `${String(x)},${String(y1)} ${String(x)},${String(midY)} ${String(x)},${String(y2)}`
    );
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
      view([node('c'), node('b', { depends_on: ['c'] }), node('a', { depends_on: ['b'] })])
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
      view(
        [node('a', { depends_on: ['ghost'] }), node('b')],
        [
          ['ghost', 'b'],
          ['a', 'nobody'],
        ]
      )
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

describe('dagStatusTone', () => {
  // The badge marks what a node is *doing*: both unfinished statuses catch the
  // eye, and only the node box below separates waiting from in flight.
  it('makes both unfinished statuses a badge worth noticing', () => {
    expect(dagStatusTone(node('a', { status: 'pending' }))).toBe('warn');
    expect(dagStatusTone(node('a', { status: 'running' }))).toBe('warn');
  });

  it('reads a settled node as its verdict', () => {
    expect(dagStatusTone(node('a', { status: 'done', verdict: 'pass' }))).toBe('success');
    expect(dagStatusTone(node('a', { status: 'done', verdict: 'fail' }))).toBe('error');
  });

  // A half-written document is not a failure here either, exactly as in `dagTone`.
  it('treats a settled node without a verdict as a success', () => {
    expect(dagStatusTone(node('a', { status: 'done' }))).toBe('success');
  });

  it('deliberately disagrees with the node tone about a running node', () => {
    const running = node('a', { status: 'running' });
    expect(dagStatusTone(running)).toBe('warn');
    expect(dagTone(running)).toBe('success');
  });
});

// the worktree state is a fact about the branch, drawn on its own axis —
// the node's own status stays what its own pills say.
describe('dagWorktreeTone', () => {
  it('marks an unmerged worktree as work still out there', () => {
    expect(dagWorktreeTone('active')).toBe('warn');
  });

  it('reads a branch that is in the main line as settled', () => {
    expect(dagWorktreeTone('merged')).toBe('success');
  });

  // The one state a reader must not miss, and the one that is a plain fact
  // rather than a warning: a removed workspace needs no attention.
  it('makes a stopped merge the one error and a removed worktree neutral', () => {
    expect(dagWorktreeTone('conflict')).toBe('error');
    expect(dagWorktreeTone('removed')).toBe('idle');
  });
});

/** A metrics record the type system believes, over values the wire may carry. */
function asMetrics(value: unknown): NonNullable<Parameters<typeof nodeMetricsMap>[0]['metrics']> {
  return value as NonNullable<Parameters<typeof nodeMetricsMap>[0]['metrics']>;
}

describe('nodeMetricsMap', () => {
  const doc = view([node('a'), node('b')]);

  it('keeps the measurement of a node the document carries', () => {
    const samples = { a: { tokens: 1200, elapsed_ms: 3200 }, b: { tokens: 12 } };
    const map = nodeMetricsMap({ dag: doc, metrics: samples });
    expect(map).toEqual({ a: { tokens: 1200, elapsed_ms: 3200 }, b: { tokens: 12 } });
    // A copy, not the route's own object: the panel must not write through it.
    expect(map['a']).not.toBe(samples.a);
  });

  it('keeps a zero measurement, which is a fact and not an absence', () => {
    expect(nodeMetricsMap({ dag: doc, metrics: { a: { tokens: 0, elapsed_ms: 0 } } })).toEqual({
      a: { tokens: 0, elapsed_ms: 0 },
    });
  });

  it('drops a measurement for a node the document does not carry', () => {
    expect(nodeMetricsMap({ dag: doc, metrics: { ghost: { tokens: 1 } } })).toEqual({});
  });

  it('drops a bad field field-by-field and keeps the good one', () => {
    expect(
      nodeMetricsMap({
        dag: doc,
        metrics: {
          a: { tokens: -1, elapsed_ms: 3200 },
          b: { tokens: 1.5, elapsed_ms: 900 },
        },
      })
    ).toEqual({ a: { elapsed_ms: 3200 }, b: { elapsed_ms: 900 } });
  });

  it('drops an entry whose every field is bad, keeping its neighbours', () => {
    expect(
      nodeMetricsMap({ dag: doc, metrics: { a: { tokens: -1 }, b: { elapsed_ms: 10 } } })
    ).toEqual({ b: { elapsed_ms: 10 } });
  });

  // The route is JSON: a value that is not even a number must be discarded, not
  // coerced. `2 ** 53` is a number TypeScript accepts and the panel must not.
  it('rejects values that are not non-negative safe integers', () => {
    expect(
      nodeMetricsMap({
        dag: doc,
        metrics: asMetrics({
          a: { tokens: Number.NaN, elapsed_ms: Number.POSITIVE_INFINITY },
          b: { tokens: 2 ** 53, elapsed_ms: 0 },
        }),
      })
    ).toEqual({ b: { elapsed_ms: 0 } });
  });

  it('survives an entry that is not an object at all', () => {
    // A null / number / string entry is discarded rather than dereferenced, and
    // the entry beside it still lands — even with a stringly-typed field.
    expect(
      nodeMetricsMap({
        dag: doc,
        metrics: asMetrics({
          a: null,
          b: { tokens: '1200', elapsed_ms: 3200 },
          ghost: 5,
        }),
      })
    ).toEqual({ b: { elapsed_ms: 3200 } });
  });

  it('answers an empty map without a document or without metrics', () => {
    expect(nodeMetricsMap({ dag: null, metrics: { a: { tokens: 1 } } })).toEqual({});
    expect(nodeMetricsMap({ dag: doc })).toEqual({});
    expect(nodeMetricsMap({ dag: null })).toEqual({});
  });

  // `at` is what tells a *stored* sample from a live reading, so the
  // panel may not draw one it cannot date: absent stays absent (live), and a
  // present one has to be a real epoch stamp.
  it('keeps a usable `at` and leaves an absent one absent', () => {
    expect(nodeMetricsMap({ dag: doc, metrics: { a: { tokens: 1, at: 0 } } })).toEqual({
      a: { tokens: 1, at: 0 },
    });
    expect(nodeMetricsMap({ dag: doc, metrics: { a: { tokens: 1, at: 1_700_000_000_000 } } })).toEqual(
      { a: { tokens: 1, at: 1_700_000_000_000 } }
    );
    // No `at` at all is the live case, and stays that way.
    expect(nodeMetricsMap({ dag: doc, metrics: { a: { tokens: 1 } } })).toEqual({ a: { tokens: 1 } });
  });

  // A sample the panel cannot date is not a sample it may age: dropping the whole
  // entry is what keeps a stale node out of the live clock, and it is also the
  // same "refuse rather than relabel" rule the two numbers follow.
  it('drops an entry whose `at` is present but unusable', () => {
    expect(
      nodeMetricsMap({
        dag: doc,
        metrics: asMetrics({
          a: { tokens: 1, at: -1 },
          b: { tokens: 2, at: 1.5 },
        }),
      })
    ).toEqual({});
    expect(
      nodeMetricsMap({
        dag: doc,
        metrics: asMetrics({
          a: { tokens: 1, at: 2 ** 53 },
          b: { elapsed_ms: 10, at: Number.NaN },
        }),
      })
    ).toEqual({});
    // The object beside it still lands: one bad entry costs only itself.
    expect(
      nodeMetricsMap({
        dag: doc,
        metrics: asMetrics({ a: { tokens: 1, at: '1700000000000' }, b: { tokens: 2 } }),
      })
    ).toEqual({ b: { tokens: 2 } });
  });
});

describe('formatCount', () => {
  it('prints a count below a thousand exactly', () => {
    expect(formatCount(0)).toBe('0');
    expect(formatCount(999)).toBe('999');
  });

  it('scales to `k`, one decimal while the value is under a hundred', () => {
    expect(formatCount(1000)).toBe('1k');
    expect(formatCount(1200)).toBe('1.2k');
    expect(formatCount(99400)).toBe('99.4k');
  });

  it('drops the decimal once the scaled value reaches a hundred', () => {
    expect(formatCount(100000)).toBe('100k');
    expect(formatCount(123456)).toBe('123k');
    // 999,999 rounds up into four digits; the next scale step is a full million.
    expect(formatCount(999999)).toBe('1000k');
  });

  it('scales to `M` above a million, on the same rule', () => {
    expect(formatCount(1e6)).toBe('1M');
    expect(formatCount(1_500_000)).toBe('1.5M');
    expect(formatCount(123_456_789)).toBe('123M');
  });
});

describe('formatSeconds', () => {
  it('truncates under a minute to whole seconds', () => {
    expect(formatSeconds(0)).toBe('0');
    expect(formatSeconds(3200)).toBe('3');
    // Truncation, not rounding: the line may not claim a second not yet elapsed.
    expect(formatSeconds(59_999)).toBe('59');
  });

  it('keeps one decimal from a minute on', () => {
    expect(formatSeconds(60_000)).toBe('60');
    expect(formatSeconds(75_400)).toBe('75.4');
    // The same truncation there: 60 499ms is 60.4s, not the 60.5s a round claims.
    expect(formatSeconds(60_499)).toBe('60.4');
    expect(formatSeconds(3_600_000)).toBe('3600');
  });

  it('reads a negative time as zero', () => {
    expect(formatSeconds(-1)).toBe('0');
    expect(formatSeconds(-75_400)).toBe('0');
  });
});

describe('liveElapsedMs', () => {
  it('has nothing to show before the first sample', () => {
    expect(liveElapsedMs(undefined, 1000, 5000)).toBeUndefined();
  });

  it('trusts a host that published no sample anchor', () => {
    expect(liveElapsedMs(3200, undefined, 9000)).toBe(3200);
  });

  it('adds the browser time since the sample', () => {
    expect(liveElapsedMs(3200, 10_000, 12_500)).toBe(5700);
    expect(liveElapsedMs(0, 10_000, 10_001)).toBe(1);
  });

  // Skew, not time travel: a browser clock behind the host adds nothing rather
  // than subtracting time the node has already run.
  it('adds nothing when the browser clock lags or matches the host', () => {
    expect(liveElapsedMs(3200, 10_000, 8000)).toBe(3200);
    expect(liveElapsedMs(3200, 10_000, 10_000)).toBe(3200);
  });
});

describe('DAG_COPY_KEYS', () => {
  // `DagBody` is the caller; these literals are also what tells the copy
  // guard that the dictionary's new keys have a use in the panel. `measuredAt`
  // joined them with the stored-sample display.
  it('names the live-metrics copy keys once', () => {
    expect(DAG_COPY_KEYS).toEqual({
      liveTokens: 'dag.liveTokens',
      seconds: 'dag.seconds',
      measuredAt: 'dag.measuredAt',
    });
  });
});

// The animation is a class the component sets and a keyframe it injects; both
// live in a `.tsx` file no Node test can import, so the guard reads the source.
describe('DAG animation contract', () => {
  it('defines the keyframes and the reduced-motion opt-out the node class needs', () => {
    const source = readFileSync(srcPath('client', 'DagBody.tsx'), 'utf8');
    expect(source).toContain('@keyframes dsh-mint-dag-pulse');
    expect(source).toContain('prefers-reduced-motion: reduce');
    expect(source).toContain('animation: none');
    // One `running` class, and it is the animation's target.
    expect(source).toContain('DAG_RUNNING_CLASS');
  });
});

// The live line is wired in the body, a `.tsx` no Node test can render: the
// button below is the source guard that keeps the wiring from being dropped.
describe('DAG live-metrics contract', () => {
  it('reads the model, the copy keys, and the styles the live line is built from', () => {
    const source = readFileSync(srcPath('client', 'DagBody.tsx'), 'utf8');
    // The sample: what to draw, which numbers to age, and which keys to say.
    expect(source).toContain('nodeMetricsMap');
    expect(source).toContain('liveElapsedMs');
    expect(source).toContain('DAG_COPY_KEYS');
    // The colors: the node's SVG line and the card's DOM line name the same pair.
    expect(source).toContain('dagLiveTokensStyle');
    expect(source).toContain('dagLiveTimeStyle');
    expect(source).toContain('DAG_NODE_METRICS');
  });

  // a stored sample is dated, and the card is where a reader can see when
  // it was taken — as a local clock string, because the copy only supplies the
  // label around it.
  it('dates a stored sample in the card', () => {
    const source = readFileSync(srcPath('client', 'DagBody.tsx'), 'utf8');
    expect(source).toContain('DAG_COPY_KEYS.measuredAt');
    expect(source).toContain('toLocaleTimeString');
  });
});

// the card is a `.tsx` no Node test can render, so the wiring that shows a
// node's worktree is guarded by reading its source. The branch and the state both
// come from the envelope — the panel never touches git.
describe('DAG worktree contract', () => {
  it('shows the branch and the state the node carries', () => {
    const source = readFileSync(srcPath('client', 'DagBody.tsx'), 'utf8');
    expect(source).toContain('node.worktree');
    expect(source).toContain('dagWorktreeTone');
    expect(source).toContain("copy('dag.worktree.branch'");
    expect(source).toContain("copy('dag.worktree.state.active')");
    expect(source).toContain("copy('dag.worktree.state.merged')");
    expect(source).toContain("copy('dag.worktree.state.conflict')");
    expect(source).toContain("copy('dag.worktree.state.removed')");
  });
});
