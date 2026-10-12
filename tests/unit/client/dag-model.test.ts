import { readdirSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { srcPath } from '../../helpers/repo.js';
import type { DagNodeView, DagPhase, DagView } from '../../../src/shared/records.js';
import {
  DAG_COPY_KEYS,
  DAG_DIRECTIONS,
  DAG_H_GAP,
  DAG_NODE_H,
  DAG_NODE_W,
  DAG_PAD,
  DAG_STAGE_GAP,
  DAG_STAGE_HEAD,
  DAG_STAGE_PAD,
  DAG_V_GAP,
  dagCounts,
  dagStatusTone,
  dagTone,
  dagWorktreeTone,
  formatCount,
  formatSeconds,
  isDagDirection,
  isRunning,
  layoutDag,
  liveElapsedMs,
  metricsBreakdown,
  nodeMetricsMap,
  stageHeadline,
} from '../../../src/client/dag-model.js';
import type { DagDirection, DagLayout } from '../../../src/client/dag-model.js';

/**
 * 面板两个文件在 Node 里都 import 不了，源码守卫只能读文本。
 *
 * `DagBody` 限大拆成 `DagBody.tsx` + 同族小文件后，读单个文件已经覆盖不到
 * 全部接线，因此这里读整个客户端面（`.ts`/`.tsx` 全量拼接）。
 */
function clientSource(): string {
  const file = srcPath('client', 'DagBody.tsx');
  const siblings = readdirSync(srcPath('client'))
    .filter((name) => name.endsWith('.ts') || name.endsWith('.tsx'))
    .map((name) => readFileSync(srcPath('client', name), 'utf8'));
  return [readFileSync(file, 'utf8'), ...siblings].join('\n');
}

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
    // 单阶段（`node()` 默认 exec）在带内成列：x 是带内留白，y 每层一个「盒高 + 层间隙」。
    expect(box(layout, 'a')).toEqual({ id: 'a', x: 22, y: 30, w: DAG_NODE_W, h: DAG_NODE_H });
    expect(box(layout, 'b')).toEqual({ id: 'b', x: 22, y: 120, w: DAG_NODE_W, h: DAG_NODE_H });
    expect(box(layout, 'c')).toEqual({ id: 'c', x: 22, y: 210, w: DAG_NODE_W, h: DAG_NODE_H });
    expect(layout.width).toBe(148);
    expect(layout.height).toBe(276);
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
    expect(box(layout, 'd').y).toBe(210);
    // A single-node layer is centered over the two-node one, inside the band.
    const center = (b: { x: number; w: number }): number => b.x + b.w / 2;
    expect(center(box(layout, 'a'))).toBe(center(box(layout, 'd')));
    expect(layout.width).toBe(268);
    expect(layout.height).toBe(276);
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
    expect(box(layout, 'a1').y).toBe(120);
    expect(box(layout, 'z').y).toBe(210);
  });

  it('reads `edges` as the same relation as `depends_on`, without duplicating', () => {
    const layout = layoutDag(view([node('a'), node('b', { depends_on: ['a'] })], [['a', 'b']]));
    expect(layout.edges).toHaveLength(1);
    expect(layout.edges[0]?.points).toBe('74,74 74,97 74,120');
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

  // 空文档也要给出最小画幅：零尺寸画布在面板上是一片点不动的空白。
  // 传空 nodes/edges，断言 boxes/edges 为空而宽高是最小框。
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

describe('layoutDag stage bands', () => {
  it('stacks one band per phase in the declared phase order', () => {
    const layout = layoutDag(
      view([
        node('r', { phase: 'research' }),
        node('e', { phase: 'exec' }),
        node('p', { phase: 'post' }),
      ])
    );
    expect(layout.bands.map((band) => band.phase)).toEqual(['research', 'exec', 'post']);
    // 三阶段各占一条带，故三个盒子必须落在三个不同的 y 上：不同阶段绝不共行。
    const rows = ['r', 'e', 'p'].map((id) => box(layout, id).y);
    expect(new Set(rows).size).toBe(3);
  });

  // 带的顺序由 `DAG_PHASES` 决定，与节点在文档里排第几无关。
  it('orders the bands by phase, not by where a node appears', () => {
    const layout = layoutDag(
      view([node('p', { phase: 'post' }), node('r', { phase: 'research' })])
    );
    expect(layout.bands.map((band) => band.phase)).toEqual(['research', 'post']);
  });

  // 跨阶段的边照画，但带外 id 会被 `dagLayers` 丢掉，故依赖不把子节点推深一层。
  it('does not let a cross-phase edge add a row inside the band', () => {
    const layout = layoutDag(
      view([node('a', { phase: 'research' }), node('b', { phase: 'exec', depends_on: ['a'] })])
    );
    const band = layout.bands.find((candidate) => candidate.phase === 'exec');
    if (band === undefined) throw new Error('no exec band');
    expect(box(layout, 'b').y).toBe(band.y + DAG_STAGE_HEAD);
    expect(layout.edges).toHaveLength(1);
  });

  it('draws no band for a phase the document does not use', () => {
    const layout = layoutDag(view([node('e', { phase: 'exec' })]));
    expect(layout.bands.map((band) => band.phase)).toEqual(['exec']);
  });

  it('keeps every node inside the band of its own phase', () => {
    const layout = layoutDag(
      view([node('a'), node('b', { depends_on: ['a'] }), node('r', { phase: 'research' })])
    );
    for (const item of layout.boxes) {
      const phase = item.id === 'r' ? 'research' : 'exec';
      const band = layout.bands.find((candidate) => candidate.phase === phase);
      if (band === undefined) throw new Error(`no band for ${item.id}`);
      expect(item.y, item.id).toBeGreaterThanOrEqual(band.y + DAG_STAGE_HEAD);
      expect(item.y + item.h, item.id).toBeLessThanOrEqual(band.y + band.h);
      expect(item.x, item.id).toBeGreaterThanOrEqual(band.x);
      expect(item.x + item.w, item.id).toBeLessThanOrEqual(band.x + band.w);
    }
  });

  // 两条带各占一段互不相交的 y 区间；带内一条链的两个节点共 y、逐层向右（横排口径）。
  it('keeps horizontal bands apart and the rows inside one aligned', () => {
    const layout = layoutDag(
      view([
        node('r', { phase: 'research' }),
        node('e1', { phase: 'exec' }),
        node('e2', { phase: 'exec', depends_on: ['e1'] }),
      ]),
      'horizontal'
    );
    const [first, second] = layout.bands;
    if (first === undefined || second === undefined) throw new Error('expected two bands');
    expect(first.phase).toBe('research');
    expect(first.y + first.h).toBeLessThanOrEqual(second.y);
    expect(box(layout, 'e2').y).toBe(box(layout, 'e1').y);
    expect(box(layout, 'e2').x).toBe(box(layout, 'e1').x + DAG_NODE_W + DAG_H_GAP);
    // 同层（同一列）的两个节点共 x、纵向依次排开。
    const sameLayer = layoutDag(
      view([node('e1', { phase: 'exec' }), node('e2', { phase: 'exec' })]),
      'horizontal'
    );
    expect(box(sameLayer, 'e2').x).toBe(box(sameLayer, 'e1').x);
    expect(box(sameLayer, 'e2').y).toBe(box(sameLayer, 'e1').y + DAG_NODE_H + DAG_V_GAP);
  });

  it('gives an empty document no bands', () => {
    expect(layoutDag(view([])).bands).toEqual([]);
  });

  // 手改坏的文件可能带枚举外的阶段：它另起一带、带内仍是完整节点，只是排在已知阶段之后。
  // `as`：这里正是要模拟那道防线之外的输入，TS 侧只能靠断言构造。
  it('draws an unknown phase as its own band after the known ones', () => {
    const weird = 'weird' as DagPhase;
    const layout = layoutDag(view([node('w', { phase: weird }), node('e', { phase: 'exec' })]));
    expect(layout.bands.map((band) => band.phase)).toEqual(['exec', 'weird']);
    expect(layout.bands[1]?.count).toBe(1);
    expect(box(layout, 'w')).toEqual({ id: 'w', x: 22, y: 122, w: DAG_NODE_W, h: DAG_NODE_H });
  });

  it('reports the band geometry the band count and the copy line need', () => {
    const layout = layoutDag(
      view([node('a'), node('b', { depends_on: ['a'] }), node('r', { phase: 'research' })])
    );
    const [first, second] = layout.bands;
    if (first === undefined || second === undefined) throw new Error('expected two bands');
    expect(first).toEqual({
      phase: 'research',
      x: DAG_PAD,
      y: DAG_PAD,
      w: DAG_NODE_W + 2 * DAG_STAGE_PAD,
      h: DAG_STAGE_HEAD + DAG_NODE_H + DAG_STAGE_PAD,
      count: 1,
    });
    expect(second.y).toBe(DAG_PAD + first.h + DAG_STAGE_GAP);
    expect(second.count).toBe(2);
  });
});

describe('stageHeadline', () => {
  const labels: Record<string, string> = {
    'dag.stage.plan': '计划阶段',
    'dag.stage.exec': '执行阶段',
    'dag.stage.post': '收尾阶段',
  };
  const copy = (key: string): string => labels[key] ?? key;

  it('names the three phases and counts the band', () => {
    expect(stageHeadline(copy, 'research', 3)).toBe('计划阶段 · 3');
    expect(stageHeadline(copy, 'exec', 0)).toBe('执行阶段 · 0');
    expect(stageHeadline(copy, 'post', 12)).toBe('收尾阶段 · 12');
  });

  // 未知阶段没有文案可查：原样报出它，而不是悄悄冒充某个已知阶段。
  it('passes an unknown phase through verbatim', () => {
    expect(stageHeadline(copy, 'weird', 2)).toBe('weird · 2');
  });
});

describe('horizontal layout', () => {
  // 横排就是竖排转 90°：同一层从「一行」变成「一列」，故层号推的是 x 而不是 y。
  // 传三层链，断言 y 齐平、x 逐层右移一个「盒宽 + 层间隙」，画幅也照列合成。
  it('lays a chain left to right, one column per layer', () => {
    const layout = layoutDag(
      view([node('a'), node('b', { depends_on: ['a'] }), node('c', { depends_on: ['b'] })]),
      'horizontal'
    );
    const step = DAG_NODE_W + DAG_H_GAP;
    expect(layout.boxes.map((item) => item.id)).toEqual(['a', 'b', 'c']);
    expect(box(layout, 'b').y).toBe(box(layout, 'a').y);
    expect(box(layout, 'a').x).toBe(22);
    expect(box(layout, 'b').x).toBe(142);
    expect(box(layout, 'c').x).toBe(262);
    expect(box(layout, 'b').x).toBe(DAG_PAD + DAG_STAGE_PAD + step);
    expect(box(layout, 'c').x).toBe(DAG_PAD + DAG_STAGE_PAD + 2 * step);
    expect(layout.width).toBe(388);
    // 最高的一列就是带内内容高度：三层各一个节点。
    expect(layout.height).toBe(96);
    expect(box(layout, 'a').y).toBe(30);
  });

  // 竖排里单节点行在**带内**水平居中；转过来之后它应当垂直居中于带内内容区，而不是整幅画布。
  // `dagLayers` 把 `a` 与 `a2` 放在同一层（都是无依赖者），单节点的 `b` 因此独居一列，
  // 而两节点列决定带内内容高度——若丢掉居中，`b` 会落在标签条下沿。
  it('vertically centers a single-node column against a taller one', () => {
    const layout = layoutDag(
      view([node('a'), node('b', { depends_on: ['a'] }), node('a2')]),
      'horizontal'
    );
    const band = layout.bands[0];
    if (band === undefined) throw new Error('no band');
    const center = (item: { y: number; h: number }): number => item.y + item.h / 2;
    const contentH = 2 * DAG_NODE_H + DAG_V_GAP;
    expect(center(box(layout, 'b'))).toBe(band.y + DAG_STAGE_HEAD + contentH / 2);
    expect(center(box(layout, 'b'))).not.toBe(center(box(layout, 'a')));
    // 同层两个节点共处一列：同一 x，纵向依次排开。
    expect(box(layout, 'a').x).toBe(box(layout, 'a2').x);
    expect(box(layout, 'a2').y).toBe(box(layout, 'a').y + DAG_NODE_H + DAG_V_GAP);
    // 高列比它高「一个盒高 + 一个间隙」，它因此下移这差值的一半。
    expect(box(layout, 'b').y).toBe(DAG_PAD + DAG_STAGE_HEAD + (DAG_NODE_H + DAG_V_GAP) / 2);
    expect(layout.height).toBe(
      DAG_PAD * 2 + DAG_STAGE_HEAD + 2 * DAG_NODE_H + DAG_V_GAP + DAG_STAGE_PAD
    );
  });

  // 边也转了：父节点右中 → 中点 x 折两次 → 子节点左中，四个坐标对。
  // 传两节点依赖，用具体盒子算出期望串并逐字断言（中点取两盒之间的那段水平间隙）。
  it('draws an elbow from the parent right-center to the child left-center', () => {
    const layout = layoutDag(view([node('a'), node('b', { depends_on: ['a'] })]), 'horizontal');
    const parent = box(layout, 'a');
    const child = box(layout, 'b');
    const x1 = parent.x + parent.w;
    const yParentMid = parent.y + parent.h / 2;
    const x2 = child.x;
    const yChildMid = child.y + child.h / 2;
    const midX = (x1 + x2) / 2;
    expect(layout.edges).toHaveLength(1);
    expect(layout.edges[0]?.points).toBe(
      `${String(x1)},${String(yParentMid)} ${String(midX)},${String(yParentMid)} ${String(midX)},${String(yChildMid)} ${String(x2)},${String(yChildMid)}`
    );
  });

  it('draws the same nodes in either direction', () => {
    const doc = view([node('a'), node('b', { depends_on: ['a'] })]);
    expect(DAG_DIRECTIONS).toEqual(['vertical', 'horizontal']);
    expect(isDagDirection('vertical')).toBe(true);
    expect(isDagDirection('horizontal')).toBe(true);
    expect(isDagDirection('diagonal')).toBe(false);
    for (const direction of DAG_DIRECTIONS) {
      const layout = layoutDag(doc, direction);
      expect(layout.boxes, direction).toHaveLength(2);
      expect(layout.edges, direction).toHaveLength(1);
    }
  });

  // 默认参数是硬契约：既有调用方与几何用例都按竖排读。
  it('defaults to the vertical direction', () => {
    const doc = view([node('a'), node('b', { depends_on: ['a'] })]);
    const explicit: DagDirection = 'vertical';
    expect(layoutDag(doc)).toEqual(layoutDag(doc, explicit));
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

  // 0 是量到的读数而不是缺失：tokens/elapsed_ms 为 0 必须原样保留。
  // 用一张全零指标表断言 map 里仍是 {0,0}。
  it('keeps a zero measurement, which is a fact and not an absence', () => {
    expect(nodeMetricsMap({ dag: doc, metrics: { a: { tokens: 0, elapsed_ms: 0 } } })).toEqual({
      a: { tokens: 0, elapsed_ms: 0 },
    });
  });

  // 文档里没有的节点不得带指标进面板：否则会画出一份幽灵读数。
  // 指标表只给 ghost，断言 map 为空。
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

  // 白名单同步守卫：四桶与步数也是宿主实测，漏收一个面板就静默少一项。
  it('keeps the four buckets and the step count alongside their sum', () => {
    expect(
      nodeMetricsMap({
        dag: doc,
        metrics: {
          a: { tokens: 10, uncached_input: 1, cache_read: 3, cache_write: 4, output: 2, steps: 7 },
        },
      })
    ).toEqual({
      a: { tokens: 10, uncached_input: 1, cache_read: 3, cache_write: 4, output: 2, steps: 7 },
    });
  });

  it('drops a bad bucket without losing its neighbours', () => {
    expect(
      nodeMetricsMap({
        dag: doc,
        metrics: asMetrics({ a: { cache_read: 1.5, steps: -1, output: 2 } }),
      })
    ).toEqual({ a: { output: 2 } });
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
    expect(
      nodeMetricsMap({ dag: doc, metrics: { a: { tokens: 1, at: 1_700_000_000_000 } } })
    ).toEqual({ a: { tokens: 1, at: 1_700_000_000_000 } });
    // No `at` at all is the live case, and stays that way.
    expect(nodeMetricsMap({ dag: doc, metrics: { a: { tokens: 1 } } })).toEqual({
      a: { tokens: 1 },
    });
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
  // `NodeCard`（.tsx）是调用方；这些字面量同时告诉 copy 守卫「词典里的新键有人用」。
  // 成本拆分那一族（四桶 + 步数）随实测构成行一起加入。
  it('names the live-metrics copy keys once', () => {
    expect(DAG_COPY_KEYS).toEqual({
      liveTokens: 'dag.liveTokens',
      seconds: 'dag.seconds',
      measuredAt: 'dag.measuredAt',
      bucketUncached: 'dag.bucket.uncachedInput',
      bucketCacheRead: 'dag.bucket.cacheRead',
      bucketCacheWrite: 'dag.bucket.cacheWrite',
      bucketOutput: 'dag.bucket.output',
      steps: 'dag.steps',
      // 方向控件（`DagBody.tsx`）也从这里取 key，故同样要在这份源码里留下字面量。
      dirLabel: 'dag.dir.label',
      dirVertical: 'dag.dir.vertical',
      dirHorizontal: 'dag.dir.horizontal',
      // 阶段带标签（`DagGraphView.tsx` 经 `stageHeadline` 取值）同理。
      stagePlan: 'dag.stage.plan',
      stageExec: 'dag.stage.exec',
      stagePost: 'dag.stage.post',
    });
  });
});

/** 一份最小词典：这里测的是拼装顺序与分隔符，词典与占位符由 copy 守卫负责。 */
const BREAKDOWN_COPY: Record<string, string> = {
  'dag.bucket.uncachedInput': '未命中',
  'dag.bucket.cacheRead': '命中',
  'dag.bucket.cacheWrite': '缓存写',
  'dag.bucket.output': '输出',
  'dag.steps': '{steps} 步',
};

function translate(key: string, params?: Record<string, string | number>): string {
  const text = BREAKDOWN_COPY[key] ?? key;
  if (params === undefined) return text;
  return text.replace(/\{(\w+)\}/g, (_match, name: string) => String(params[name] ?? ''));
}

describe('metricsBreakdown', () => {
  // 顺序契约：未命中 → 命中 → 缓存写 → 输出 → 步数，与 `DagNodeMetrics` 的字段顺序一致。
  it('assembles the measured items in a fixed order', () => {
    expect(
      metricsBreakdown(
        { tokens: 16_300, uncached_input: 3400, cache_read: 12_000, output: 900, steps: 12 },
        translate
      )
    ).toBe('未命中 3.4k · 命中 12k · 输出 900 · 12 步');
  });

  // 缺失不猜：没测到的项不画（不是画 0），一项都没有就整行不画。
  it('lists only what the host measured, and nothing at all when it measured none', () => {
    expect(metricsBreakdown({ tokens: 10, cache_write: 5 }, translate)).toBe('缓存写 5');
    expect(metricsBreakdown({ tokens: 10 }, translate)).toBeUndefined();
    expect(metricsBreakdown({ elapsed_ms: 100 }, translate)).toBeUndefined();
    expect(metricsBreakdown(undefined, translate)).toBeUndefined();
  });

  it('keeps a zero bucket, which is a measurement and not an absence', () => {
    expect(metricsBreakdown({ cache_read: 0 }, translate)).toBe('命中 0');
  });
});

// The animation is a class the component sets and a keyframe it injects; both
// live in a `.tsx` file no Node test can import, so the guard reads the source.
describe('DAG animation contract', () => {
  it('defines the keyframes and the reduced-motion opt-out the node class needs', () => {
    const source = clientSource();
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
    const source = clientSource();
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
    const source = clientSource();
    expect(source).toContain('DAG_COPY_KEYS.measuredAt');
    expect(source).toContain('toLocaleTimeString');
  });
});

// 旋转控件同样活在 `.tsx` 里：这里的字面量就是「容器收下方向、视图照它画」的接线守卫。
describe('DAG direction contract', () => {
  it('forwards the direction the container holds into the drawing model', () => {
    const source = clientSource();
    expect(source).toContain('DagDirection');
    expect(source).toContain('setDirection');
    expect(source).toContain('layoutDag(dag, direction)');
  });

  it('names the direction control from the shared copy keys', () => {
    const source = clientSource();
    expect(source).toContain('DAG_COPY_KEYS.dirLabel');
    expect(source).toContain('DAG_COPY_KEYS.dirVertical');
    expect(source).toContain('DAG_COPY_KEYS.dirHorizontal');
  });
});

// the card is a `.tsx` no Node test can render, so the wiring that shows a
// node's worktree is guarded by reading its source. The branch and the state both
// come from the envelope — the panel never touches git.
describe('DAG worktree contract', () => {
  it('shows the branch and the state the node carries', () => {
    const source = clientSource();
    expect(source).toContain('node.worktree');
    expect(source).toContain('dagWorktreeTone');
    expect(source).toContain("copy('dag.worktree.branch'");
    expect(source).toContain("copy('dag.worktree.state.active')");
    expect(source).toContain("copy('dag.worktree.state.merged')");
    expect(source).toContain("copy('dag.worktree.state.conflict')");
    expect(source).toContain("copy('dag.worktree.state.removed')");
  });
});

// 阶段带同样活在 `.tsx` 里：这里的字面量就是「布局给出带、视图照它画、表头走字典」的接线守卫。
describe('DAG stage-band contract', () => {
  it('draws the bands the layout reports, with the styled headline', () => {
    const source = clientSource();
    expect(source).toContain('layout.bands');
    expect(source).toContain('dagStageStyle');
    expect(source).toContain('DAG_STAGE_LABEL');
    expect(source).toContain('stageHeadline');
    // 新枚举值的节点标签：`phaseLabel` 的 switch 是穷尽的，字面量必须落在源码里。
    expect(source).toContain("copy('dag.phase.post')");
  });
});
