/**
 * The plan DAG's drawing model: status coloring, node geometry, and the
 * topological layout the panel renders as SVG (plan #31 §4.3).
 *
 * The host publishes no coordinates — the document is a graph, and one layout
 * here keeps the browser the single place that decides pixels. Everything in
 * this file is a pure function of the view, so the geometry can be checked in
 * Node without a DOM, and the same view always draws the same picture.
 */
import { dagLayers } from '../dag.js';
import type { DagNodeMetrics, DagNodeView, DagView } from '../records.js';
import type { StatusTone } from './model.js';

/**
 * The node box: wide enough for a six-code-point label, short enough to stack.
 *
 * The height carries two lines — the label and, under it, the measured metric
 * pair — which is what took it from 34 to 44.
 */
export const DAG_NODE_W = 104;
export const DAG_NODE_H = 44;

/** Horizontal gap inside a layer; vertical gap between layers (edges run in it). */
export const DAG_H_GAP = 16;
export const DAG_V_GAP = 46;

/** Canvas margin; also the minimum canvas, so an empty DAG still has a frame. */
export const DAG_PAD = 12;

/**
 * The three theme state tones a node can take.
 *
 * A status and a verdict collapse into one axis here: `done` alone has no color
 * of its own, because what a reader needs to see is the outcome, not the fact
 * that the node stopped moving.
 */
export type DagTone = 'warn' | 'success' | 'error';

export interface DagBox {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One edge as an SVG `<polyline>`: `points` is the `x,y x,y x,y` string. */
export interface DagEdgeLine {
  from: string;
  to: string;
  points: string;
}

export interface DagLayout {
  width: number;
  height: number;
  boxes: DagBox[];
  edges: DagEdgeLine[];
}

/**
 * The theme tone a node draws in.
 *
 * `pending` is amber (waiting), `running` is green (in flight), and a settled
 * node reads its verdict — green for pass, red for fail. A `done` node with no
 * verdict is the host's own tolerance for a half-written document, and is drawn
 * as a success rather than as an error it is not.
 */
export function dagTone(node: DagNodeView): DagTone {
  if (node.status === 'pending') return 'warn';
  if (node.status === 'running') return 'success';
  return node.verdict === 'fail' ? 'error' : 'success';
}

/** True for the one status whose box pulses, so the CSS class has one owner. */
export function isRunning(node: DagNodeView): boolean {
  return node.status === 'running';
}

/**
 * The tone the node's status badge (`pill()`) draws in.
 *
 * A second reading of the same node on purpose, not {@link dagTone}: the badge
 * is a chip on a row and says what the node is *doing*, so `pending` and
 * `running` are both worth catching the eye — amber — while the box underneath
 * keeps its own axis (amber for waiting, green for in flight). Only a refuted
 * node is red in both.
 */
export function dagStatusTone(node: DagNodeView): StatusTone {
  if (node.status === 'pending' || node.status === 'running') return 'warn';
  return node.verdict === 'fail' ? 'error' : 'success';
}

/**
 * The union dependency graph as edges, keyed `child → parents`.
 *
 * `depends_on` and `edges` are two spellings of the same relation (`[from, to]`
 * means `to` depends on `from`), so an edge may arrive twice; the union keeps
 * one copy of each pair. References to unknown ids are dropped rather than
 * drawn, and the iteration starts from `view.nodes` so the result is ordered by
 * the document, not by a map's insertion history.
 */
function parentEdges(view: DagView): Array<[string, string]> {
  const known = new Set(view.nodes.map((node) => node.id));
  const pairs: Array<[string, string]> = [];
  const seen = new Set<string>();
  const add = (from: string, to: string): void => {
    if (from === to || !known.has(from) || !known.has(to)) return;
    const key = `${from}\u0000${to}`;
    if (seen.has(key)) return;
    seen.add(key);
    pairs.push([from, to]);
  };
  for (const node of view.nodes) {
    for (const dependency of node.depends_on) add(dependency, node.id);
  }
  for (const [from, to] of view.edges) add(from, to);
  return pairs;
}

/** A coordinate in an SVG attribute: trimmed of float noise, never `1e-7`. */
function round(value: number): string {
  return String(Number(value.toFixed(3)));
}

/**
 * Lay one DAG out: layers top-down, nodes left-to-right and centered.
 *
 * The layering is the host's own (`dagLayers`), which tolerates cycles and
 * dangling references instead of throwing — a hand-edited file must render as a
 * wrong picture, never as a blank panel.
 *
 * @param view - the document as the route published it.
 */
export function layoutDag(view: DagView): DagLayout {
  // `dagLayers` already answers top-down: layer 0 is the nodes that wait for
  // nothing, and a node sits one past its deepest dependency — which is exactly
  // the row the drawing wants, with every edge running downward. Empty levels
  // (only reachable through a cycle) are skipped by the loop below.
  const layers = dagLayers(view.nodes, view.edges);
  const depth = new Map<string, number>();
  layers.forEach((layer, level) => {
    for (const id of layer) depth.set(id, level);
  });

  // Groups follow `view.nodes` order, so a node the layering dropped (it cannot
  // happen today, but the shapes are independent) still gets a box.
  const groups: string[][] = [];
  for (const node of view.nodes) {
    const level = depth.get(node.id) ?? 0;
    (groups[level] ??= []).push(node.id);
  }

  let width = 0;
  for (const group of groups) {
    if (group === undefined || group.length === 0) continue;
    width = Math.max(width, group.length * DAG_NODE_W + (group.length - 1) * DAG_H_GAP);
  }
  // An empty document still gets a frame: a zero-width SVG would collapse to
  // nothing, and the pane's empty state is the notice above it, not the canvas.
  width = Math.max(width, DAG_NODE_W);

  const boxes: DagBox[] = [];
  const at = new Map<string, DagBox>();
  groups.forEach((group, level) => {
    if (group.length === 0) return;
    const rowWidth = group.length * DAG_NODE_W + (group.length - 1) * DAG_H_GAP;
    const left = DAG_PAD + (width - rowWidth) / 2;
    group.forEach((id, column) => {
      const box: DagBox = {
        id,
        x: left + column * (DAG_NODE_W + DAG_H_GAP),
        y: DAG_PAD + level * (DAG_NODE_H + DAG_V_GAP),
        w: DAG_NODE_W,
        h: DAG_NODE_H,
      };
      boxes.push(box);
      at.set(id, box);
    });
  });

  const edges: DagEdgeLine[] = [];
  for (const [from, to] of parentEdges(view)) {
    const parent = at.get(from);
    const child = at.get(to);
    if (parent === undefined || child === undefined) continue;
    // Three points: out of the parent's bottom edge, across at the middle of the
    // gap, into the child's top edge. Only the middle y needs choosing, and the
    // gap is wide enough for the two horizontal runs to read as one elbow.
    const x1 = parent.x + parent.w / 2;
    const y1 = parent.y + parent.h;
    const x2 = child.x + child.w / 2;
    const y2 = child.y;
    const midY = (y1 + y2) / 2;
    edges.push({
      from,
      to,
      points: `${round(x1)},${round(y1)} ${round(x2)},${round(midY)} ${round(x2)},${round(y2)}`,
    });
  }

  return {
    width: DAG_PAD * 2 + width,
    height: DAG_PAD * 2 + groups.length * DAG_NODE_H + Math.max(0, groups.length - 1) * DAG_V_GAP,
    boxes,
    edges,
  };
}

/** The node/edge/status counts the panel's summary line is built from. */
export function dagCounts(view: DagView): {
  nodes: number;
  edges: number;
  pending: number;
  running: number;
  done: number;
} {
  const counts = {
    nodes: view.nodes.length,
    edges: view.edges.length,
    pending: 0,
    running: 0,
    done: 0,
  };
  for (const node of view.nodes) counts[node.status] += 1;
  return counts;
}

/**
 * The copy keys the node's measured line is built from.
 *
 * `DagBody` is the only caller (issue #164) and is a `.tsx` this module cannot
 * import from, so the keys are named once here instead of being spelled in two
 * files. It also answers the panel's copy guard, which reads source text: a key
 * the dictionary carries but no source ever quotes is a dead key.
 */
export const DAG_COPY_KEYS = {
  liveTokens: 'dag.liveTokens',
  seconds: 'dag.seconds',
} as const;

/** A metric value the panel is willing to draw, or `undefined`. */
function measuredInt(value: unknown): number | undefined {
  // The host publishes the pair, but the route is JSON: a negative, fractional,
  // or non-numeric value is a bug worth dropping, not a number worth drawing.
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** One node's entry, field by field: a bad `tokens` keeps a good `elapsed_ms`. */
function keepMetrics(raw: unknown): DagNodeMetrics {
  const entry = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const tokens = measuredInt(entry['tokens']);
  const elapsedMs = measuredInt(entry['elapsed_ms']);
  const kept: DagNodeMetrics = {};
  if (tokens !== undefined) kept.tokens = tokens;
  if (elapsedMs !== undefined) kept.elapsed_ms = elapsedMs;
  return kept;
}

/**
 * The host's per-node measurements, filtered down to what may be drawn.
 *
 * The route may measure nodes this answer's document no longer carries, and a
 * half-read sample may hold one good field beside a bad one; both are dropped
 * per rule, so a node shows what is true rather than what it was typed as. The
 * result is empty — never a zero guess — when there is no document, when the
 * answer carries no metrics at all, or when nothing survived.
 *
 * @param payload - the route answer, reduced to the two fields that matter.
 */
export function nodeMetricsMap(payload: {
  metrics?: Record<string, DagNodeMetrics>;
  dag: DagView | null;
}): Record<string, DagNodeMetrics> {
  const { dag, metrics } = payload;
  if (dag === null || metrics === undefined) return {};
  const known = new Set(dag.nodes.map((node) => node.id));
  const kept: Record<string, DagNodeMetrics> = {};
  for (const [id, raw] of Object.entries(metrics)) {
    if (!known.has(id)) continue;
    const entry = keepMetrics(raw);
    if (entry.tokens === undefined && entry.elapsed_ms === undefined) continue;
    kept[id] = entry;
  }
  return kept;
}

/** `1.2` / `123`: one decimal below a hundred, whole at or above it. */
function scaled(value: number): string {
  // `String` drops a trailing `.0`, so the exact thousands read `1k`, not `1.0k`.
  return String(value >= 100 ? Math.round(value) : Math.round(value * 10) / 10);
}

/**
 * A token count as one short label: `999`, `1.2k`, `123k`, `1.5M`.
 *
 * Below a thousand the count is exact; above it, scaled and rounded — one
 * decimal until the scaled value reaches a hundred, where a decimal is
 * precision the reader cannot use and columns the box does not have.
 *
 * @param tokens - a non-negative token count.
 */
export function formatCount(tokens: number): string {
  if (tokens < 1e3) return String(tokens);
  if (tokens < 1e6) return `${scaled(tokens / 1e3)}k`;
  return `${scaled(tokens / 1e6)}M`;
}

/**
 * An elapsed time as seconds, the way the live line shows it.
 *
 * Always seconds: a node is a subagent run, and minutes-and-seconds would spend
 * columns without adding reach. Under a minute the value is truncated to whole
 * seconds (`3200` → `3`, `59999` → `59`); from a minute on it keeps one decimal
 * (`75400` → `75.4`). Truncation rather than rounding is deliberate — the line
 * may not claim a second that has not elapsed. Negative time is clock skew and
 * reads as zero.
 *
 * @param ms - elapsed milliseconds, as the host measured or the panel derived.
 */
export function formatSeconds(ms: number): string {
  if (ms <= 0) return '0';
  if (ms < 60000) return String(Math.floor(ms / 1000));
  return String(Math.floor(ms / 100) / 10);
}

/**
 * The elapsed time a running node should show right now.
 *
 * The host samples `elapsed_ms` only when it answers, so a live line between
 * two answers is that sample plus the time since — which needs the anchor's
 * clock (`sampled_at`) as much as the browser's `now`. The two clocks need not
 * agree: a negative gap is skew, not time travel, and adds nothing. A host that
 * published no anchor is trusted to be current.
 *
 * @param elapsedMs - the host's last sample, or `undefined` before the first.
 * @param sampledAtMs - the host time that sample was taken at.
 * @param nowMs - the browser's current time.
 */
export function liveElapsedMs(
  elapsedMs: number | undefined,
  sampledAtMs: number | undefined,
  nowMs: number
): number | undefined {
  if (elapsedMs === undefined) return undefined;
  if (sampledAtMs === undefined) return elapsedMs;
  return elapsedMs + Math.max(0, nowMs - sampledAtMs);
}
