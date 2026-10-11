/**
 * Host-measured per-node usage for the plan DAG.
 *
 * The DAG document only carries what a child *reports about itself*; this module
 * is the host's second opinion. It reads the child session's own projection
 * state and turns it into the two live fields the panel draws, falling back to
 * the sample persisted in the document when the child session is gone, and two
 * rules carry the whole design:
 *
 * - **Missing, never guessed**: a value is published only when the host really
 *   read it, so the panel can tell "not measured" from "zero". Every shape check
 *   refuses instead of coercing, and a metric that cannot be read is simply
 *   absent rather than a plausible-looking `0`.
 * - **State, not wire view**: `ctx.sessionProjections.stateOf` answers a unit's
 *   durable state object, so the field names below are the state schemas of
 *   `@deepseek-ai/dsh-token-meter` and the subagent timing projection — never the
 *   rendered view. Every read runs inside one `try`/`catch`: a projection
 *   registry from another host build must not take the DAG route down.
 *
 * Unlike `dag.ts`, this module is host-only (it reads the DAG document through
 * `dag-store.js`), so it is free to reach the file layer; the browser half never
 * inlines it.
 */
import { DAG_DIR, readDag } from './dag-store.js';
import { sampleOf } from './dag.js';
import { isRecord } from '../mint/mint-json.js';
import type { DagDoc, DagSample } from './dag.js';
import type { DagNodeMetrics, DagNodeView, DagStatus } from '../shared/records.js';
import type { AgentsLike, SessionProjectionsLike } from '../shared/types.js';

/** 一次读到的四桶：`tokens` 只是它们的和，命中与未命中的单价却差约 50 倍。 */
export interface DagTokenBuckets {
  uncached_input: number;
  cache_read: number;
  cache_write: number;
  output: number;
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * 宿主投影 state 的 `totals` 里四个 durable 桶，逐个显式读取。
 *
 * 字段对应关系只写在这里一次：`uncachedInputTokens` → `uncached_input`（未命中）、
 * `cacheReadTokens` → `cache_read`（命中）、`cacheWriteTokens` → `cache_write`、
 * `outputTokens` → `output`（reasoning ⊆ output）。
 */
function readTotals(totals: Record<string, unknown>): DagTokenBuckets | undefined {
  const uncached = totals['uncachedInputTokens'];
  const cacheRead = totals['cacheReadTokens'];
  const cacheWrite = totals['cacheWriteTokens'];
  const output = totals['outputTokens'];
  if (!isCount(uncached) || !isCount(cacheRead) || !isCount(cacheWrite) || !isCount(output)) {
    return undefined;
  }
  return { uncached_input: uncached, cache_read: cacheRead, cache_write: cacheWrite, output };
}

/**
 * 读一次 `tokenUsage` 投影 state 的四桶，逐桶校验。
 *
 * 四桶**要么同在要么同缺**：任一桶缺失或不是非负安全整数就整组不发布——半组合法值会
 * 让求和静默少算，而分开落盘时更会被读成「这一桶就是 0」。
 *
 * @param usage - the `tokenUsage` projection **state** (not its wire view).
 * @returns 四桶，或读不到/形状不对时的 `undefined`。
 */
export function tokenBuckets(usage: unknown): DagTokenBuckets | undefined {
  if (!isRecord(usage)) return undefined;
  const totals = usage['totals'];
  if (!isRecord(totals)) return undefined;
  return readTotals(totals);
}

/** 四桶之和：`tokens` 的语义（四桶不相交，求和即该会话用掉的 token 总数）。 */
function sumBuckets(buckets: DagTokenBuckets): number {
  return buckets.uncached_input + buckets.cache_read + buckets.cache_write + buckets.output;
}

/**
 * Sum a session's four durable token buckets.
 *
 * @param usage - the `tokenUsage` projection **state** (not its wire view).
 * @returns the sum, or `undefined` when any bucket is missing or not a
 *   non-negative safe integer — a partial total would silently understate usage.
 */
export function tokenTotal(usage: unknown): number | undefined {
  const buckets = tokenBuckets(usage);
  return buckets === undefined ? undefined : sumBuckets(buckets);
}

/**
 * 该会话已结算的步数（`sessionStats.steps`，`step/end` 计数）。
 *
 * @param stats - the `sessionStats` projection state.
 * @returns 步数；`sessionStats` 未注册或形状不对时 `undefined`（步数缺失只影响它自己，
 *   不连累四桶）。
 */
export function sessionSteps(stats: unknown): number | undefined {
  if (!isRecord(stats)) return undefined;
  const steps = stats['steps'];
  return isCount(steps) ? steps : undefined;
}

/**
 * The active-turn duration the host's own subagent timing reports.
 *
 * The formula and the clock match the dsh subagent UI: past turns are frozen in
 * `settledMs`, and the turn in flight is `sampledMs - active.since`. A running
 * node is measured at the host's sample clock; a settled one at the `through`
 * its projection recorded, so the answer does not depend on when the panel asks.
 *
 * @param timing - the `subagentTiming` projection state.
 * @param status - the node's lifecycle; only `running` uses the sample clock.
 * @param sampledMs - the host clock (epoch ms) this sample is taken at.
 * @returns the milliseconds, or `undefined` when a value it depends on is
 *   missing or malformed — the caller omits the field rather than guessing.
 */
export function activeElapsedMs(
  timing: unknown,
  status: DagStatus,
  sampledMs: number
): number | undefined {
  if (!isRecord(timing)) return undefined;
  const settledMs = timing['settledMs'];
  if (!isCount(settledMs)) return undefined;
  const active = timing['active'];
  if (active === undefined || active === null) return settledMs;
  if (!isRecord(active)) return undefined;
  const since = active['since'];
  if (!isCount(since)) return undefined;
  const end = status === 'running' ? sampledMs : active['through'];
  if (!isCount(end)) return undefined;
  return settledMs + Math.max(0, end - since);
}

/**
 * Read one node's live metrics off the host's projection registry.
 *
 * The whole body is one `try`/`catch`: `stateOf` belongs to another package and
 * may throw for a session it does not know, which must cost this node its
 * metrics, not the route its answer.
 */
export function nodeMetrics(input: {
  session: unknown;
  projections: SessionProjectionsLike;
  status: DagStatus;
  sampledMs: number;
}): DagNodeMetrics {
  try {
    const metrics: DagNodeMetrics = {};
    const buckets = tokenBuckets(input.projections.stateOf(input.session, 'tokenUsage'));
    if (buckets !== undefined) {
      // 四桶同在：求和与拆分是同一次读数的两副面孔，面板既有 `tokens` 可读，也能分开看成本。
      metrics.tokens = sumBuckets(buckets);
      metrics.uncached_input = buckets.uncached_input;
      metrics.cache_read = buckets.cache_read;
      metrics.cache_write = buckets.cache_write;
      metrics.output = buckets.output;
    }
    // 步数独立于四桶：`sessionStats` 读不到只是不发布它，四桶照旧。
    const steps = sessionSteps(input.projections.stateOf(input.session, 'sessionStats'));
    if (steps !== undefined) metrics.steps = steps;
    const elapsed = activeElapsedMs(
      input.projections.stateOf(input.session, 'subagentTiming'),
      input.status,
      input.sampledMs
    );
    if (elapsed !== undefined) metrics.elapsed_ms = elapsed;
    return metrics;
  } catch {
    return {};
  }
}

export interface MeasureDagNodesInput {
  sessionId: string;
  /** DAG directory override; absent means {@link DAG_DIR}. */
  dagDir?: string;
  /** Live agents, by session id; `undefined` in compositions without the service. */
  agents: AgentsLike | undefined;
  /** The projection registry; `undefined` when the composition does not provide it. */
  projections: SessionProjectionsLike | undefined;
  /** The host clock this sample is taken at (epoch ms). */
  sampledMs: number;
}

/** The read-only wrapper's input, kept under the name its route seam was declared with. */
export type DagMetricsInput = MeasureDagNodesInput;

/**
 * Merge a live measurement with a persisted sample, per node: live wins, stored
 * fills the gap.
 *
 * Only the ids the document still declares are answered, so a sample left behind
 * by a removed node never reaches the panel. The two sources are deliberately
 * distinguishable in the result: a live entry carries no `at` (its time is the
 * answer's own `sampled_at`), a stored one carries the `at` it was persisted
 * with. A stored entry is re-validated because a caller may hand over a reading
 * it read itself — a half-bad one is trimmed, and one with nothing left is
 * dropped rather than published.
 *
 * @param input.nodes - the document's nodes; iteration order is the output's.
 */
export function mergeMetrics(input: {
  live: Record<string, DagNodeMetrics>;
  stored: Record<string, DagSample> | undefined;
  remembered?: Record<string, DagNodeMetrics>;
  nodes: readonly DagNodeView[];
}): Record<string, DagNodeMetrics> {
  const merged: Record<string, DagNodeMetrics> = {};
  for (const node of input.nodes) {
    const live = input.live[node.id];
    if (live !== undefined) {
      const entry: DagNodeMetrics = { ...live };
      delete entry.at;
      merged[node.id] = entry;
      continue;
    }
    const stored = input.stored?.[node.id];
    if (stored !== undefined) {
      const sample = sampleOf(stored, stored.at);
      if (sample !== undefined) merged[node.id] = sample;
      // A stored sample is authoritative for the node: the memory may hold a
      // later reading, but the document is the record the host committed.
      continue;
    }
    // Not in the document yet (nothing has persisted it): the host's last live
    // reading still answers, dated by when it was taken, so a panel shows the
    // real number while the persist step catches up.
    const remembered = input.remembered?.[node.id];
    if (remembered !== undefined) merged[node.id] = { ...remembered };
  }
  return merged;
}

/**
 * 落在样本里的计数字段（`at` 是落库戳，不在其中）。
 *
 * 字段集只在这里定义一次：落盘节流（`routes.ts`）与重建校验都照着同一份清单走，
 * 新增字段不会被某一处漏掉。顺序即字段在 JSON 里的书写顺序。
 */
const SAMPLE_NUMBERS = [
  'tokens',
  'uncached_input',
  'cache_read',
  'cache_write',
  'output',
  'steps',
  'elapsed_ms',
] as const satisfies readonly (keyof DagSample)[];

/** 两份样本的计数字段是否全等（`at` 不参与）：任一字段不同就是一份新读数。 */
export function sameSampleNumbers(before: DagSample, after: DagSample): boolean {
  return SAMPLE_NUMBERS.every((field) => before[field] === after[field]);
}

/**
 * 除时长外，读数里还有没有一个计数动了（四桶、求和或步数）。
 *
 * 时长本身由调用方按写节流阈值把关，故这里刻意把它排除；`undefined` 不算「动」——
 * 那次读数压根没测到那一项。
 */
export function sampleNumbersMoved(before: DagSample, after: DagSample): boolean {
  return SAMPLE_NUMBERS.some(
    (field) =>
      field !== 'elapsed_ms' && after[field] !== undefined && after[field] !== before[field]
  );
}

/**
 * Read one session's document and answer every node's metrics: the live
 * measurement where the host has one, the persisted sample otherwise.
 *
 * This is {@link readDagMetrics} plus the stored fallback, and the fallback is
 * the point: a node whose child session has settled (or a composition with no
 * projection registry at all) still answers with the last sample the host
 * persisted, so "measured once" survives the session that measured it.
 */
export async function measureDagNodes(
  input: MeasureDagNodesInput
): Promise<{ metrics: Record<string, DagNodeMetrics>; doc: DagDoc | undefined }> {
  const read = await readDag(input.sessionId, input.dagDir ?? DAG_DIR);
  if (read.state !== 'ok') return { metrics: {}, doc: undefined };
  const { doc } = read;
  const { projections } = input;
  const live: Record<string, DagNodeMetrics> = {};
  if (projections !== undefined) {
    for (const node of doc.nodes) {
      if (node.agent === undefined) continue;
      const agent = input.agents?.get(node.agent);
      if (agent === undefined || agent === null) continue;
      // `agents.get` answers either an agent wrapper (`{ session }`) or the session
      // itself, depending on the host's shape; the fallback eats both.
      const session = (agent as { session?: unknown }).session ?? agent;
      const found = nodeMetrics({
        session,
        projections,
        status: node.status,
        sampledMs: input.sampledMs,
      });
      if (Object.keys(found).length > 0) {
        live[node.id] = found;
        // Remember it here rather than at the caller: this is the one place that
        // sees a live reading, and the memory is what keeps the number alive
        // once the child is gone (the `subagent/end` hook cannot measure — the
        // registry already dropped the child by then).
        rememberMeasurement(input.sessionId, node.id, found, input.sampledMs);
      }
    }
  }
  return {
    metrics: mergeMetrics({
      live,
      stored: doc.samples,
      remembered: rememberedMetrics(input.sessionId),
      nodes: doc.nodes,
    }),
    doc,
  };
}

/** {@link measureDagNodes} 的只读面：只要 metrics；没测到任何值的节点整条缺席。 */
export async function readDagMetrics(
  input: DagMetricsInput
): Promise<Record<string, DagNodeMetrics>> {
  return (await measureDagNodes(input)).metrics;
}

/**
 * The cap on remembered measurements per session.
 *
 * The plan document is itself bounded, so this is a leak guard rather than a
 * real limit: a long-lived host must not keep one entry per node id ever seen.
 */
const MEASUREMENT_MAX = 200;

/** The most recent live measurement per session, per node, oldest inserted first. */
const measurements = new Map<string, Map<string, DagNodeMetrics>>();

/**
 * Remember one live measurement, so a node can still be persisted once its child
 * session is gone.
 *
 * The fields pass through {@link sampleOf}, so the memory can never hold a
 * reading the document would refuse; an entry with no usable number is ignored
 * instead of remembered. Re-remembering a node moves it to the newest position,
 * and a session keeps at most {@link MEASUREMENT_MAX} entries, oldest evicted
 * first (a `Map` iterates in insertion order).
 *
 * @param at - when that reading was taken (epoch ms); defaults to now. It travels
 *   with the numbers because a sample persisted later must carry the moment it
 *   was *measured*, not the moment it happened to be written.
 */
export function rememberMeasurement(
  sessionId: string,
  nodeId: string,
  metrics: DagNodeMetrics,
  at: number = Date.now()
): void {
  const kept = sampleOf(metrics, at);
  if (kept === undefined) return;
  const entries = measurements.get(sessionId) ?? new Map<string, DagNodeMetrics>();
  measurements.set(sessionId, entries);
  // Deleting first makes the re-inserted pair the newest of the session.
  entries.delete(nodeId);
  const entry: DagNodeMetrics = { at: kept.at };
  if (kept.tokens !== undefined) entry.tokens = kept.tokens;
  if (kept.uncached_input !== undefined) entry.uncached_input = kept.uncached_input;
  if (kept.cache_read !== undefined) entry.cache_read = kept.cache_read;
  if (kept.cache_write !== undefined) entry.cache_write = kept.cache_write;
  if (kept.output !== undefined) entry.output = kept.output;
  if (kept.steps !== undefined) entry.steps = kept.steps;
  if (kept.elapsed_ms !== undefined) entry.elapsed_ms = kept.elapsed_ms;
  entries.set(nodeId, entry);
  while (entries.size > MEASUREMENT_MAX) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) break;
    entries.delete(oldest);
  }
}

function rememberedMetrics(sessionId: string): Record<string, DagNodeMetrics> {
  const entries = measurements.get(sessionId);
  if (entries === undefined) return {};
  return Object.fromEntries([...entries].map(([nodeId, metrics]) => [nodeId, { ...metrics }]));
}

export function lastMeasurement(sessionId: string, nodeId: string): DagNodeMetrics | undefined {
  const found = measurements.get(sessionId)?.get(nodeId);
  // A copy: the caller is about to merge this reading into a document, and must
  // not be able to rewrite the cached one through the copy it was handed.
  return found === undefined ? undefined : { ...found };
}

export function clearMeasurements(sessionId?: string): void {
  if (sessionId === undefined) {
    measurements.clear();
    return;
  }
  measurements.delete(sessionId);
}
