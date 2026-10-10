/**
 * 图算法：依赖并集、未知依赖、成环检测、分层与计数摘要。
 *
 * 全部是纯函数、只看节点与边，不碰文档的其余字段；面板画图与工具校验共用。
 */
import type { DagCounts, DagDoc, DagNode } from './model.js';

/**
 * The dependency graph of known nodes: every node mapped to the nodes it waits
 * for. `depends_on` and `edges` are unioned (an edge is just a second way to
 * state one dependency), and references to unknown ids are dropped — they are
 * reported by {@link unknownDependencies} instead.
 */
function dependencyGraph(
  nodes: readonly DagNode[],
  edges: readonly (readonly [string, string])[]
): Map<string, string[]> {
  const known = new Set(nodes.map((node) => node.id));
  const graph = new Map<string, string[]>();
  for (const node of nodes) {
    const deps: string[] = [];
    for (const dependency of node.depends_on) {
      if (known.has(dependency) && !deps.includes(dependency)) deps.push(dependency);
    }
    graph.set(node.id, deps);
  }
  for (const [from, to] of edges) {
    const deps = graph.get(to);
    if (deps === undefined || !known.has(from) || deps.includes(from)) continue;
    deps.push(from);
  }
  return graph;
}

/**
 * Every id referenced by a dependency that no node declares, sorted and unique.
 *
 * The list is what makes a rejected `add` actionable: the model sees exactly
 * which references it got wrong instead of a generic failure.
 */
export function unknownDependencies(
  nodes: readonly DagNode[],
  edges: readonly (readonly [string, string])[]
): string[] {
  const known = new Set(nodes.map((node) => node.id));
  const unknown = new Set<string>();
  for (const node of nodes) {
    for (const dependency of node.depends_on) {
      if (!known.has(dependency)) unknown.add(dependency);
    }
  }
  for (const [from, to] of edges) {
    if (!known.has(from)) unknown.add(from);
    if (!known.has(to)) unknown.add(to);
  }
  return [...unknown].sort();
}

/**
 * One cycle of the union graph, as a closed path (`['a','b','a']`), or
 * `undefined` for an acyclic graph.
 *
 * A DAG is the whole point of the model, so the tool refuses the write and
 * echoes the cycle rather than storing a graph the panel could not layer.
 */
export function findCycle(
  nodes: readonly DagNode[],
  edges: readonly (readonly [string, string])[]
): string[] | undefined {
  const graph = dependencyGraph(nodes, edges);
  const state = new Map<string, 'open' | 'closed'>();
  const stack: string[] = [];
  const visit = (id: string): string[] | undefined => {
    const seen = state.get(id);
    if (seen === 'closed') return undefined;
    if (seen === 'open') {
      const start = stack.indexOf(id);
      return [...stack.slice(start), id];
    }
    state.set(id, 'open');
    stack.push(id);
    for (const dependency of graph.get(id) ?? []) {
      const cycle = visit(dependency);
      if (cycle !== undefined) return cycle;
    }
    stack.pop();
    state.set(id, 'closed');
    return undefined;
  };
  for (const id of graph.keys()) {
    const cycle = visit(id);
    if (cycle !== undefined) return cycle;
  }
  return undefined;
}

/**
 * The graph's layers, top-down: `layers[0]` holds every node with no unmet
 * dependency, and a node's layer is one past its deepest dependency.
 *
 * Deliberately **tolerant**: the panel renders whatever it was handed, so a
 * cycle (a back edge) contributes nothing to the depth instead of throwing, and
 * references to unknown ids are ignored. The strict checks live in
 * {@link findCycle} / {@link unknownDependencies} and gate the write path.
 */
export function dagLayers(
  nodes: readonly DagNode[],
  edges: readonly (readonly [string, string])[]
): string[][] {
  const graph = dependencyGraph(nodes, edges);
  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  const depthOf = (id: string): number => {
    const cached = depth.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    let level = 0;
    for (const dependency of graph.get(id) ?? []) {
      level = Math.max(level, depthOf(dependency) + 1);
    }
    visiting.delete(id);
    depth.set(id, level);
    return level;
  };
  const layers: string[][] = [];
  for (const id of graph.keys()) {
    const level = depthOf(id);
    const layer = layers[level] ?? [];
    layer.push(id);
    layers[level] = layer;
  }
  return layers;
}

export function dagCounts(doc: DagDoc): DagCounts {
  const counts: DagCounts = {
    nodes: doc.nodes.length,
    edges: doc.edges.length,
    pending: 0,
    running: 0,
    done: 0,
  };
  for (const node of doc.nodes) counts[node.status] += 1;
  return counts;
}

export function dagSummary(doc: DagDoc | undefined): string {
  if (doc === undefined) return '本会话暂无 DAG';
  const counts = dagCounts(doc);
  const head =
    `节点 ${String(counts.nodes)}，边 ${String(counts.edges)}：` +
    `pending ${String(counts.pending)} / running ${String(counts.running)} / done ${String(counts.done)}`;
  const running = doc.nodes.filter((node) => node.status === 'running');
  if (running.length === 0) return head;
  const shown = running.slice(0, 8).map((node) => `${node.label}(${node.id})`);
  const tail = running.length > shown.length ? `, …+${String(running.length - shown.length)}` : '';
  return `${head}\nrunning: ${shown.join(', ')}${tail}`;
}
