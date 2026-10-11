/**
 * 存盘文档的读取校验：整份严格、`samples` 单条宽松。
 *
 * 读的是**不可信方向**（文件在 `/tmp`），所以形状错误、版本不符都变成具名错误，
 * 由路由转成面板告警而不是崩溃。
 */
import { isRecord } from '../../../mint/mint-json.js';
import type { DagNodeMetrics, DagWorktree } from '../../../shared/records.js';
import { DAG_VERSION, isValidDagSession } from './model.js';
import type { DagDoc, DagNode, DagSample, DagVerdict } from './model.js';
import {
  checkEdge,
  checkLabel,
  checkNodeId,
  checkTitle,
  checkWorktree,
  isCount,
  isDagPhase,
  isDagStatus,
  isDagVerdict,
} from './validate.js';

/**
 * One node's sample, built from a raw reading: `at` must be a usable stamp, and
 * every count field is validated **one by one**, so a malformed one is dropped —
 * but at least one count must survive for the reading to be worth storing.
 *
 * Field-wise on purpose: a live reading is the one source where a single number
 * can be junk while another was really measured, and throwing the good one away
 * would be the same guess this module refuses to make. A *stored* entry is
 * stricter — see {@link parseDagDoc}.
 */
export function sampleOf(metrics: DagNodeMetrics, at: number): DagSample | undefined {
  if (!isCount(at)) return undefined;
  const kept: DagNodeMetrics = {};
  // 逐字段：坏值只丢它自己（例如 `tokens` 坏了不该连累好的 `cache_read`）。
  if (isCount(metrics.tokens)) kept.tokens = metrics.tokens;
  if (isCount(metrics.uncached_input)) kept.uncached_input = metrics.uncached_input;
  if (isCount(metrics.cache_read)) kept.cache_read = metrics.cache_read;
  if (isCount(metrics.cache_write)) kept.cache_write = metrics.cache_write;
  if (isCount(metrics.output)) kept.output = metrics.output;
  if (isCount(metrics.steps)) kept.steps = metrics.steps;
  if (isCount(metrics.elapsed_ms)) kept.elapsed_ms = metrics.elapsed_ms;
  // 一个数都没活下来就不是一次读数：绝不落一条只有 `at` 的空样本。
  if (Object.keys(kept).length === 0) return undefined;
  return { ...kept, at };
}

/** A stored field is either absent or a usable count; nothing is coerced. */
function isSampleField(value: unknown): boolean {
  return value === undefined || isCount(value);
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
  const phase = raw.phase;
  if (!isDagPhase(phase)) return { error: `node ${id}: invalid phase` };
  const status = raw.status;
  if (!isDagStatus(status)) return { error: `node ${id}: invalid status` };
  let verdict: DagVerdict | undefined;
  if (raw.verdict !== undefined) {
    const checked = raw.verdict;
    if (!isDagVerdict(checked)) return { error: `node ${id}: invalid verdict` };
    verdict = checked;
  }
  if (!Array.isArray(raw.depends_on) || raw.depends_on.some((dep) => typeof dep !== 'string')) {
    return { error: `node ${id}: depends_on must be a string array` };
  }
  if (typeof raw.updated_at !== 'string')
    return { error: `node ${id}: updated_at must be a string` };
  if (
    raw.issue !== undefined &&
    (typeof raw.issue !== 'number' || !Number.isSafeInteger(raw.issue))
  ) {
    return { error: `node ${id}: issue must be an integer` };
  }
  if (
    raw.tokens !== undefined &&
    (typeof raw.tokens !== 'number' || !Number.isSafeInteger(raw.tokens))
  ) {
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
    phase,
    status,
    ...(verdict === undefined ? {} : { verdict }),
    depends_on: [...(raw.depends_on as string[])],
    ...(raw.issue === undefined ? {} : { issue: raw.issue }),
    ...(raw.agent === undefined ? {} : { agent: raw.agent }),
    ...(raw.tokens === undefined ? {} : { tokens: raw.tokens }),
    ...(raw.note === undefined ? {} : { note: raw.note }),
    ...(worktree === undefined ? {} : { worktree }),
    updated_at: raw.updated_at,
  };
}

/**
 * `samples` is the deliberate exception to the strictness: a bad entry there is
 * dropped on its own (see the loop below), because a measurement the host can no
 * longer trust must not take a readable plan down with it.
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
      if (
        !isSampleField(entry.tokens) ||
        !isSampleField(entry.uncached_input) ||
        !isSampleField(entry.cache_read) ||
        !isSampleField(entry.cache_write) ||
        !isSampleField(entry.output) ||
        !isSampleField(entry.steps) ||
        !isSampleField(entry.elapsed_ms)
      )
        continue;
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
