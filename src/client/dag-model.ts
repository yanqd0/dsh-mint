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
import type { DagNodeView, DagView } from '../records.js';

/** The node box: wide enough for a six-code-point label, short enough to stack. */
export const DAG_NODE_W = 104;
export const DAG_NODE_H = 34;

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
