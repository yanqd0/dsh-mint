/**
 * The plan DAG's data layer (plan #31): document shape, argument validation,
 * cycle detection, and the topological layering the panel draws.
 *
 * Pure data and pure functions only — **no `node:` import**: the browser half
 * inlines this module (`src/client/dag-model.ts`) exactly as it does
 * `route-paths.ts`, so anything reaching for a builtin would break the client
 * bundle. Every filesystem concern lives in `dag-store.ts`.
 *
 * The document the tool owns is {@link DagDoc} (a {@link DagView} plus the two
 * ownership fields); the subset the panel receives is declared once in
 * `records.ts`, so the host and the browser cannot drift apart.
 */
import { isRecord } from '../mint/mint-json.js';
import { hasControlCharacter } from '../shared/text.js';
import type {
  DagNodeView,
  DagPhase,
  DagStatus,
  DagVerdict,
  DagView,
  DagWorktree,
  DagWorktreeState,
} from '../shared/records.js';

/** The only document version this build reads or writes. */
export const DAG_VERSION = 1;

/** A node label is drawn inside the box; six code points is the panel's budget. */
export const DAG_LABEL_MAX = 6;

/** A node title is the tooltip's headline; long enough, still bounded. */
export const DAG_TITLE_MAX = 200;

/** A node's conclusion text is quoted verbatim; bounded so one read stays cheap. */
export const DAG_NOTE_MAX = 16 * 1024;

/** A document is a plan's shape, not a log; past this it is a modelling error. */
export const DAG_NODE_MAX = 200;

/** An id travels in a URL and in a path segment; this is the only accepted shape. */
const SESSION_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Node ids are referenced by other nodes, so they stay short and unpunctuated. */
const NODE_ID_MAX = 64;

/** A subagent session id, as backfilled by the host's lifecycle pairing. */
const AGENT_ID_MAX = 128;

/** Longest accepted title from an `init` call. */
const DOC_TITLE_MAX = 200;

export const DAG_PHASES: readonly DagPhase[] = ['research', 'exec'];
export const DAG_STATUSES: readonly DagStatus[] = ['pending', 'running', 'done'];
export const DAG_VERDICTS: readonly DagVerdict[] = ['pass', 'fail'];

/** True for a session id safe to use as a path segment (never concatenate first). */
export function isValidDagSession(id: string): boolean {
  return SESSION_ID.test(id);
}

/** One node of the document: the wire record, as the host stores it. */
export type DagNode = DagNodeView;

/**
 * One node's persisted host measurement (`samples[id]`): what the panel falls
 * back to once the child session is gone. Not the node's self-reported `tokens`.
 */
export interface DagSample {
  tokens?: number;
  elapsed_ms?: number;
  at: number;
}

/**
 * The stored document: {@link DagView} plus the fields that only make sense on
 * disk (the version that gates reading, and the session that owns the file).
 */
export interface DagDoc extends DagView {
  version: typeof DAG_VERSION;
  session: string;
  /**
   * Host-measured samples, keyed by node id.
   *
   * Nothing in this module writes it: this batch only **reads and validates** it
   * (see {@link parseDagDoc} / {@link sampleOf}), and `applyDagWrite` keeps
   * whatever the current document already carries because it spreads it. The
   * fallback persistence belongs to the lifecycle and merges into this key
   * through `updateDag`, so a writer must merge by hand instead of expecting an
   * action here to produce `samples` (#168).
   */
  samples?: Record<string, DagSample>;
}

/** A node as `add` supplies it; `status`/`updated_at` are the host's. */
export interface DagAddNode {
  id: string;
  label: string;
  title: string;
  phase: DagPhase;
  depends_on: string[];
  issue?: number;
}

/** The worktree states a stored document may carry (#172). */
export const DAG_WORKTREE_STATES: readonly DagWorktreeState[] = [
  'active',
  'merged',
  'conflict',
  'removed',
];

/** One validated `mint_plan_dag` call. */
export type DagAction =
  | { action: 'init'; title: string }
  | { action: 'add'; nodes: DagAddNode[]; edges: [string, string][] }
  | {
      action: 'set';
      id: string;
      status: DagStatus;
      verdict?: DagVerdict;
      note?: string;
      tokens?: number;
      agent?: string;
      /** Persisted by the worktree tool; an ordinary `set` leaves it alone. */
      worktree?: DagWorktree;
    }
  | { action: 'get' };

/**
 * The actions that write a document.
 *
 * The worktree actions are absent on purpose: they change the **filesystem**
 * (git worktrees) and live in the standalone `worktree` tool, which persists the
 * resulting node state as a follow-up `set`, so a failed git command never
 * leaves a claim in the document.
 */
export type DagWrite = Extract<DagAction, { action: 'init' | 'add' | 'set' }>;

/** A document mutation's outcome: the new document, or why nothing changed. */
export type DagResult = { doc: DagDoc } | { error: string };

/** The node counts the tool's summaries and the panel's header both show. */
export interface DagCounts {
  nodes: number;
  edges: number;
  pending: number;
  running: number;
  done: number;
}

function codePoints(text: string): number {
  return Array.from(text).length;
}

/**
 * Byte length without a Node builtin.
 *
 * The Node-only byte-length global is unavailable in the browser bundle, and
 * this module ships into it; `TextEncoder` exists in both realms, so one
 * implementation serves both.
 */
function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

function isDagPhase(value: unknown): value is DagPhase {
  return typeof value === 'string' && (DAG_PHASES as readonly string[]).includes(value);
}

function isDagStatus(value: unknown): value is DagStatus {
  return typeof value === 'string' && (DAG_STATUSES as readonly string[]).includes(value);
}

function isDagVerdict(value: unknown): value is DagVerdict {
  return typeof value === 'string' && (DAG_VERDICTS as readonly string[]).includes(value);
}

/**
 * A node id: short, non-empty, and free of control characters.
 *
 * Exported because the standalone `worktree` tool validates the same `node`
 * argument: one rule, one place, no second copy to drift.
 */
export function checkNodeId(raw: unknown): string | { error: string } {
  if (typeof raw !== 'string' || raw.length === 0) return { error: '节点 id 必须是非空字符串' };
  if (codePoints(raw) > NODE_ID_MAX) return { error: `节点 id 过长（>${String(NODE_ID_MAX)} 字）` };
  if (hasControlCharacter(raw)) return { error: `节点 id 含控制字符：${JSON.stringify(raw)}` };
  return raw;
}

function checkLabel(raw: unknown): string | { error: string } {
  if (typeof raw !== 'string' || raw.length === 0) return { error: 'label 必须是非空字符串' };
  if (codePoints(raw) > DAG_LABEL_MAX) {
    return { error: `label 超过 ${String(DAG_LABEL_MAX)} 字：${JSON.stringify(raw)}` };
  }
  if (hasControlCharacter(raw)) return { error: `label 含控制字符：${JSON.stringify(raw)}` };
  return raw;
}

function checkTitle(raw: unknown): string | { error: string } {
  if (typeof raw !== 'string' || raw.length === 0) return { error: 'title 必须是非空字符串' };
  if (codePoints(raw) > DAG_TITLE_MAX) {
    return { error: `title 超过 ${String(DAG_TITLE_MAX)} 字` };
  }
  return raw;
}

function checkNote(raw: unknown): string | { error: string } {
  if (typeof raw !== 'string') return { error: 'note 必须是字符串' };
  if (utf8Length(raw) > DAG_NOTE_MAX) {
    return { error: `note 超过 ${String(DAG_NOTE_MAX)} 字节` };
  }
  return raw;
}

/** A non-negative safe integer; the one shape every count this module keeps has. */
function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** A non-negative safe integer, e.g. a self-reported token count. */
function checkCount(raw: unknown, name: string): number | { error: string } {
  if (!isCount(raw)) return { error: `${name} 必须是非负整数` };
  return raw;
}

/**
 * One node's worktree record (#172).
 *
 * Strict on read and on write for the same reason the rest of this module is: a
 * path or branch the panel would print is either a plain string this host wrote
 * or it is not data worth keeping. Empty strings are refused because they would
 * render as a blank line where a path belongs.
 *
 * `target` 是可选字段（#189）：#189 之前的节点没有它，缺省必须可读；但一旦出现
 * 就按同一标准校验。
 */
function checkWorktree(raw: unknown, where: string): DagWorktree | { error: string } {
  if (!isRecord(raw)) return { error: `${where}: worktree 必须是对象` };
  for (const field of ['path', 'branch', 'base'] as const) {
    const value = raw[field];
    if (typeof value !== 'string' || value.length === 0) {
      return { error: `${where}: worktree.${field} 必须是非空字符串` };
    }
    if (hasControlCharacter(value)) return { error: `${where}: worktree.${field} 含控制字符` };
  }
  if (!isDagWorktreeState(raw.state)) {
    return { error: `${where}: worktree.state 必须是 ${DAG_WORKTREE_STATES.join(' | ')}` };
  }
  if (raw.merged_sha !== undefined && typeof raw.merged_sha !== 'string') {
    return { error: `${where}: worktree.merged_sha 必须是字符串` };
  }
  // target 可选（旧节点没有这条记录，见 `DagWorktree.target`）：存在时必须是真分支
  // 名，空串会渲染成空白、控制字符会破坏行格式。
  if (raw.target !== undefined && (typeof raw.target !== 'string' || raw.target.length === 0)) {
    return { error: `${where}: worktree.target 必须是非空字符串` };
  }
  if (typeof raw.target === 'string' && hasControlCharacter(raw.target)) {
    return { error: `${where}: worktree.target 含控制字符` };
  }
  return {
    path: raw.path as string,
    branch: raw.branch as string,
    base: raw.base as string,
    state: raw.state,
    ...(raw.merged_sha === undefined ? {} : { merged_sha: raw.merged_sha }),
    ...(raw.target === undefined ? {} : { target: raw.target }),
  };
}

function isDagWorktreeState(value: unknown): value is DagWorktreeState {
  return typeof value === 'string' && (DAG_WORKTREE_STATES as readonly string[]).includes(value);
}

/**
 * One node's sample, built from a raw reading: `at` must be a usable stamp, and
 * the two numbers are validated field by field so that a malformed one is
 * dropped — but at least one must survive for the reading to be worth storing.
 *
 * Field-wise on purpose: a live reading is the one source where a single number
 * can be junk while the other was really measured, and throwing the good one away
 * would be the same guess this module refuses to make. (Reading a *stored* entry
 * is stricter — see {@link parseDagDoc}.)
 *
 * @param metrics - the measured numbers, from a projection or from a file.
 * @param at - the host clock (epoch ms) the measurement was sampled at.
 * @returns the sample to store, or `undefined` when nothing is storable.
 */
export function sampleOf(
  metrics: { tokens?: number; elapsed_ms?: number },
  at: number
): DagSample | undefined {
  if (!isCount(at)) return undefined;
  const kept: { tokens?: number; elapsed_ms?: number } = {};
  if (isCount(metrics.tokens)) kept.tokens = metrics.tokens;
  if (isCount(metrics.elapsed_ms)) kept.elapsed_ms = metrics.elapsed_ms;
  if (kept.tokens === undefined && kept.elapsed_ms === undefined) return undefined;
  return { ...kept, at };
}

/** True for a stored sample field that is either absent or a usable count. */
function isSampleField(value: unknown): boolean {
  return value === undefined || isCount(value);
}

/** One `add` node entry, validated against the shape rules (not the graph). */
function checkAddNode(raw: unknown): DagAddNode | { error: string } {
  if (!isRecord(raw)) return { error: 'nodes 的每一项必须是对象' };
  const id = checkNodeId(raw.id);
  if (typeof id !== 'string') return id;
  const label = checkLabel(raw.label);
  if (typeof label !== 'string') return label;
  const title = checkTitle(raw.title);
  if (typeof title !== 'string') return title;
  if (!isDagPhase(raw.phase)) {
    return { error: `phase 必须是 ${DAG_PHASES.join(' | ')}：${JSON.stringify(raw.phase)}` };
  }
  const dependsOn: string[] = [];
  if (raw.depends_on !== undefined) {
    if (!Array.isArray(raw.depends_on)) return { error: `${id}.depends_on 必须是字符串数组` };
    for (const dependency of raw.depends_on) {
      if (typeof dependency !== 'string' || dependency.length === 0) {
        return { error: `${id}.depends_on 必须是非空字符串数组` };
      }
      if (!dependsOn.includes(dependency)) dependsOn.push(dependency);
    }
  }
  let issue: number | undefined;
  if (raw.issue !== undefined) {
    const checked = checkCount(raw.issue, `${id}.issue`);
    if (typeof checked !== 'number') return checked;
    issue = checked;
  }
  return {
    id,
    label,
    title,
    phase: raw.phase,
    depends_on: dependsOn,
    ...(issue === undefined ? {} : { issue }),
  };
}

/** One `[from, to]` edge: exactly two non-empty node ids. */
function checkEdge(raw: unknown): [string, string] | { error: string } {
  if (!Array.isArray(raw) || raw.length !== 2) return { error: 'edges 的每一项必须是 [from, to]' };
  const [from, to] = raw as [unknown, unknown];
  if (typeof from !== 'string' || from.length === 0 || typeof to !== 'string' || to.length === 0) {
    return { error: 'edges 的 from/to 必须是非空字符串' };
  }
  return [from, to];
}

/**
 * Validate raw tool arguments into a typed action.
 *
 * This checks everything decidable without the current document (shape, enums,
 * limits); the graph rules — unknown dependencies, cycles, the node ceiling —
 * are enforced by {@link applyDagWrite}, which is the only place that sees both
 * the incoming nodes and the stored ones.
 *
 * @param raw - the tool call's arguments, however malformed.
 */
export function parseDagAction(raw: unknown): DagAction | { error: string } {
  if (!isRecord(raw)) return { error: '参数必须是对象' };
  const { action } = raw;
  if (action === 'get') return { action: 'get' };
  if (action === 'init') {
    if (raw.title === undefined) return { action: 'init', title: '' };
    if (typeof raw.title !== 'string') return { error: 'title 必须是字符串' };
    if (codePoints(raw.title) > DOC_TITLE_MAX) {
      return { error: `title 超过 ${String(DOC_TITLE_MAX)} 字` };
    }
    return { action: 'init', title: raw.title };
  }
  if (action === 'add') {
    if (!Array.isArray(raw.nodes) || raw.nodes.length === 0) {
      return { error: 'add 需要非空的 nodes 数组' };
    }
    const nodes: DagAddNode[] = [];
    const seen = new Set<string>();
    for (const entry of raw.nodes) {
      const node = checkAddNode(entry);
      if ('error' in node) return node;
      if (seen.has(node.id)) return { error: `nodes 里有重复 id：${node.id}` };
      seen.add(node.id);
      nodes.push(node);
    }
    const edges: [string, string][] = [];
    if (raw.edges !== undefined) {
      if (!Array.isArray(raw.edges)) return { error: 'edges 必须是数组' };
      for (const entry of raw.edges) {
        const edge = checkEdge(entry);
        if ('error' in edge) return edge;
        edges.push(edge);
      }
    }
    return { action: 'add', nodes, edges };
  }
  if (action === 'set') {
    const id = checkNodeId(raw.id);
    if (typeof id !== 'string') return id;
    if (!isDagStatus(raw.status)) {
      return { error: `status 必须是 ${DAG_STATUSES.join(' | ')}：${JSON.stringify(raw.status)}` };
    }
    if (raw.verdict !== undefined) {
      if (!isDagVerdict(raw.verdict)) {
        return { error: `verdict 必须是 ${DAG_VERDICTS.join(' | ')}：${JSON.stringify(raw.verdict)}` };
      }
      if (raw.status !== 'done') {
        return { error: 'verdict 只在 status="done"（终态）时合法；请先完成该节点' };
      }
    }
    let note: string | undefined;
    if (raw.note !== undefined) {
      const checked = checkNote(raw.note);
      if (typeof checked !== 'string') return checked;
      note = checked;
    }
    let tokens: number | undefined;
    if (raw.tokens !== undefined) {
      const checked = checkCount(raw.tokens, 'tokens');
      if (typeof checked !== 'number') return checked;
      tokens = checked;
    }
    let agent: string | undefined;
    if (raw.agent !== undefined) {
      if (typeof raw.agent !== 'string' || raw.agent.length === 0) {
        return { error: 'agent 必须是非空字符串' };
      }
      if (raw.agent.length > AGENT_ID_MAX) return { error: `agent 过长（>${String(AGENT_ID_MAX)} 字）` };
      agent = raw.agent;
    }
    let worktree: DagWorktree | undefined;
    if (raw.worktree !== undefined) {
      const checked = checkWorktree(raw.worktree, `node ${id}`);
      if ('error' in checked) return checked;
      worktree = checked;
    }
    return {
      action: 'set',
      id,
      status: raw.status,
      ...(raw.verdict === undefined ? {} : { verdict: raw.verdict }),
      ...(note === undefined ? {} : { note }),
      ...(tokens === undefined ? {} : { tokens }),
      ...(agent === undefined ? {} : { agent }),
      ...(worktree === undefined ? {} : { worktree }),
    };
  }
  return { error: `action 必须是 init | add | set | get：${JSON.stringify(action)}` };
}

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

/** The node/edge/status counts both summaries are built from. */
export function dagCounts(doc: DagDoc): DagCounts {
  const counts: DagCounts = { nodes: doc.nodes.length, edges: doc.edges.length, pending: 0, running: 0, done: 0 };
  for (const node of doc.nodes) counts[node.status] += 1;
  return counts;
}

/** `节点 8，边 6：pending 3 / running 2 / done 3`, plus the running ids. */
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

/** A fresh document for one session; `init` rewrites the file with this. */
export function emptyDag(session: string, title: string, now: string): DagDoc {
  return {
    version: DAG_VERSION,
    session,
    title,
    revision: 1,
    created_at: now,
    updated_at: now,
    nodes: [],
    edges: [],
  };
}

/**
 * Apply one write action to the current document.
 *
 * `current` is the document as read (or `undefined` for a missing file): the
 * graph rules need it because an `add` only makes sense against what is already
 * there. Nothing is written on `error` — the caller stores the returned
 * document or reports the refusal verbatim.
 *
 * @param action - a validated write action.
 * @param current - the stored document, or `undefined` when there is none.
 * @param session - the owning (root) session id.
 * @param now - ISO timestamp; a parameter so tests need no fake timers.
 */
export function applyDagWrite(
  action: DagWrite,
  current: DagDoc | undefined,
  session: string,
  now: string
): DagResult {
  if (action.action === 'init') {
    return { doc: emptyDag(session, action.title, now) };
  }
  if (current === undefined) {
    return { error: '本会话暂无 DAG；先用 action="init" 建立，再 add/set' };
  }
  if (action.action === 'add') {
    const existing = new Set(current.nodes.map((node) => node.id));
    const collision = action.nodes.find((node) => existing.has(node.id));
    if (collision !== undefined) return { error: `节点 id 已存在：${collision.id}` };
    if (current.nodes.length + action.nodes.length > DAG_NODE_MAX) {
      return { error: `节点数超过上限 ${String(DAG_NODE_MAX)}（当前 ${String(current.nodes.length)}）` };
    }
    const added: DagNode[] = action.nodes.map((node) => ({
      ...node,
      status: 'pending',
      updated_at: now,
    }));
    const nodes = [...current.nodes, ...added];
    const edges = [...current.edges, ...action.edges];
    const unknown = unknownDependencies(nodes, edges);
    if (unknown.length > 0) {
      return { error: `未知依赖（没有对应节点）：${unknown.join(', ')}` };
    }
    const cycle = findCycle(nodes, edges);
    if (cycle !== undefined) return { error: `成环，拒绝写入：${cycle.join(' → ')}` };
    return { doc: { ...current, nodes, edges, revision: current.revision + 1, updated_at: now } };
  }
  const index = current.nodes.findIndex((node) => node.id === action.id);
  if (index < 0) return { error: `节点不存在：${action.id}` };
  const previous = current.nodes[index] as DagNode;
  // A settled node keeps no stale verdict: re-opening it drops the outcome, and
  // `set` to `done` is the only way a verdict is ever written.
  const rewritten: DagNode = {
    ...previous,
    status: action.status,
    updated_at: now,
  };
  delete rewritten.verdict;
  if (action.verdict !== undefined) rewritten.verdict = action.verdict;
  if (action.note !== undefined) rewritten.note = action.note;
  if (action.tokens !== undefined) rewritten.tokens = action.tokens;
  if (action.agent !== undefined) rewritten.agent = action.agent;
  // 与 agent/tokens 相反：worktree 是持久事实（git 里真有这棵树），普通 `set`
  // 不传就保持原样，不能被清空——只有独立的 `worktree` 工具会带新值进来覆盖。
  if (action.worktree !== undefined) rewritten.worktree = action.worktree;
  const nodes = [...current.nodes];
  nodes[index] = rewritten;
  return { doc: { ...current, nodes, revision: current.revision + 1, updated_at: now } };
}

/**
 * Validate one stored document.
 *
 * Reading is the untrusted direction (the file lives in `/tmp`), so a malformed
 * or future-versioned document becomes a named error the route turns into a
 * warning rather than a crash. `samples` is the deliberate exception: a bad
 * entry there is dropped on its own (see the loop below), because a measurement
 * the host can no longer trust must not take a readable plan down with it.
 */
export function parseDagDoc(raw: unknown): { doc: DagDoc } | { error: string } {
  if (!isRecord(raw)) return { error: 'document must be an object' };
  if (raw.version !== DAG_VERSION) {
    return { error: `unsupported version: ${JSON.stringify(raw.version)}` };
  }
  if (typeof raw.session !== 'string' || !isValidDagSession(raw.session)) {
    return { error: 'session is not a valid session id' };
  }
  if (typeof raw.title !== 'string') return { error: 'title must be a string' };
  if (typeof raw.revision !== 'number' || !Number.isSafeInteger(raw.revision) || raw.revision < 0) {
    return { error: 'revision must be a non-negative integer' };
  }
  if (typeof raw.created_at !== 'string' || typeof raw.updated_at !== 'string') {
    return { error: 'created_at/updated_at must be strings' };
  }
  if (!Array.isArray(raw.nodes) || !Array.isArray(raw.edges)) {
    return { error: 'nodes/edges must be arrays' };
  }
  const nodes: DagNode[] = [];
  const ids = new Set<string>();
  for (const entry of raw.nodes) {
    const node = parseStoredNode(entry);
    if ('error' in node) return node;
    if (ids.has(node.id)) return { error: `duplicate node id: ${node.id}` };
    ids.add(node.id);
    nodes.push(node);
  }
  const edges: [string, string][] = [];
  for (const entry of raw.edges) {
    const edge = checkEdge(entry);
    if ('error' in edge) return edge;
    edges.push(edge);
  }
  // `samples` is the one lenient field: it is a measurement, not a rule, so an
  // unusable entry costs only itself instead of making the whole plan unreadable
  // (a non-object container is still a malformed document, though).
  let samples: Record<string, DagSample> | undefined;
  if (raw.samples !== undefined) {
    if (!isRecord(raw.samples)) return { error: 'samples must be an object' };
    const kept: Record<string, DagSample> = {};
    for (const [id, entry] of Object.entries(raw.samples)) {
      if (!isRecord(entry)) continue;
      const at = entry.at;
      if (!isCount(at)) continue;
      // A stored entry is trusted whole: a field that is present but unusable
      // means the writer and this reader disagree, so none of it is kept. An
      // entry with no number at all is not a measurement either.
      if (!isSampleField(entry.tokens) || !isSampleField(entry.elapsed_ms)) continue;
      const sample = sampleOf(entry, at);
      if (sample !== undefined) kept[id] = sample;
    }
    samples = kept;
  }
  return {
    doc: {
      version: DAG_VERSION,
      session: raw.session,
      title: raw.title,
      revision: raw.revision,
      created_at: raw.created_at,
      updated_at: raw.updated_at,
      nodes,
      edges,
      // Absent stays absent: an old document round-trips unchanged, and the key's
      // presence is what tells a reader that samples were ever taken.
      ...(samples === undefined ? {} : { samples }),
    },
  };
}

/** One stored node, validated strictly (a reader may not invent defaults). */
function parseStoredNode(raw: unknown): DagNode | { error: string } {
  if (!isRecord(raw)) return { error: 'node must be an object' };
  const id = checkNodeId(raw.id);
  if (typeof id !== 'string') return id;
  const label = checkLabel(raw.label);
  if (typeof label !== 'string') return label;
  const title = checkTitle(raw.title);
  if (typeof title !== 'string') return title;
  if (!isDagPhase(raw.phase)) return { error: `node ${id}: invalid phase` };
  if (!isDagStatus(raw.status)) return { error: `node ${id}: invalid status` };
  if (raw.verdict !== undefined && !isDagVerdict(raw.verdict)) {
    return { error: `node ${id}: invalid verdict` };
  }
  if (!Array.isArray(raw.depends_on) || raw.depends_on.some((dep) => typeof dep !== 'string')) {
    return { error: `node ${id}: depends_on must be a string array` };
  }
  if (typeof raw.updated_at !== 'string') return { error: `node ${id}: updated_at must be a string` };
  if (raw.issue !== undefined && (typeof raw.issue !== 'number' || !Number.isSafeInteger(raw.issue))) {
    return { error: `node ${id}: issue must be an integer` };
  }
  if (raw.tokens !== undefined && (typeof raw.tokens !== 'number' || !Number.isSafeInteger(raw.tokens))) {
    return { error: `node ${id}: tokens must be an integer` };
  }
  if (raw.agent !== undefined && typeof raw.agent !== 'string') {
    return { error: `node ${id}: agent must be a string` };
  }
  if (raw.note !== undefined && typeof raw.note !== 'string') {
    return { error: `node ${id}: note must be a string` };
  }
  let worktree: DagWorktree | undefined;
  if (raw.worktree !== undefined) {
    const checked = checkWorktree(raw.worktree, `node ${id}`);
    if ('error' in checked) return { error: checked.error };
    worktree = checked;
  }
  return {
    id,
    label,
    title,
    phase: raw.phase,
    status: raw.status,
    ...(raw.verdict === undefined ? {} : { verdict: raw.verdict }),
    depends_on: [...(raw.depends_on as string[])],
    ...(raw.issue === undefined ? {} : { issue: raw.issue }),
    ...(raw.agent === undefined ? {} : { agent: raw.agent }),
    ...(raw.tokens === undefined ? {} : { tokens: raw.tokens }),
    ...(raw.note === undefined ? {} : { note: raw.note }),
    ...(worktree === undefined ? {} : { worktree }),
    updated_at: raw.updated_at,
  };
}
