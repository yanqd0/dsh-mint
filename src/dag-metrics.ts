/**
 * Host-measured per-node usage for the plan DAG (#161, samples #167).
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
import { isRecord } from './mint-json.js';
import type { DagDoc, DagSample } from './dag.js';
import type { DagNodeMetrics, DagNodeView, DagStatus } from './records.js';
import type { AgentsLike, SessionProjectionsLike } from './types.js';

/** The four durable buckets `@deepseek-ai/dsh-token-meter` keeps per session. */
const TOKEN_BUCKETS = [
  'uncachedInputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
] as const;

/** True for the only accepted metric value: a non-negative safe integer. */
function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Sum a session's four durable token buckets.
 *
 * @param usage - the `tokenUsage` projection **state** (not its wire view).
 * @returns the sum, or `undefined` when any bucket is missing or not a
 *   non-negative safe integer — a partial total would silently understate usage.
 */
export function tokenTotal(usage: unknown): number | undefined {
  if (!isRecord(usage)) return undefined;
  const totals = usage['totals'];
  if (!isRecord(totals)) return undefined;
  let sum = 0;
  for (const bucket of TOKEN_BUCKETS) {
    const value = totals[bucket];
    if (!isCount(value)) return undefined;
    sum += value;
  }
  return sum;
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
 *
 * @param input.session - the child session the projections are keyed by.
 * @param input.projections - the host's registry.
 * @param input.status - the node's lifecycle, for the timing formula.
 * @param input.sampledMs - the host clock (epoch ms) this sample is taken at.
 * @returns only the fields that were actually read; `{}` when neither was.
 */
export function nodeMetrics(input: {
  session: unknown;
  projections: SessionProjectionsLike;
  status: DagStatus;
  sampledMs: number;
}): DagNodeMetrics {
  try {
    const metrics: DagNodeMetrics = {};
    const tokens = tokenTotal(input.projections.stateOf(input.session, 'tokenUsage'));
    if (tokens !== undefined) metrics.tokens = tokens;
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

/** Everything one metrics read needs: the DAG to read and the host to read it from. */
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
 * @param input.live - what the host just measured, keyed by node id.
 * @param input.stored - the document's `samples`, or `undefined` when it has none.
 * @param input.nodes - the document's nodes; iteration order is the output's.
 * @returns one entry per node that has either source.
 */
export function mergeMetrics(input: {
  live: Record<string, DagNodeMetrics>;
  stored: Record<string, DagSample> | undefined;
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
    if (stored === undefined) continue;
    const sample = sampleOf(stored, stored.at);
    if (sample !== undefined) merged[node.id] = sample;
  }
  return merged;
}

/**
 * Read one session's document and answer every node's metrics: the live
 * measurement where the host has one, the persisted sample otherwise.
 *
 * This is {@link readDagMetrics} plus the stored fallback, and the fallback is
 * the point: a node whose child session has settled (or a composition with no
 * projection registry at all) still answers with the last sample the host
 * persisted, so "measured once" survives the session that measured it.
 *
 * @param input - the session whose DAG to read, plus the host services.
 * @returns the metrics of every node that has at least one of them, plus the
 *   document they were read from (`undefined` when there is none to read).
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
      if (Object.keys(found).length > 0) live[node.id] = found;
    }
  }
  return { metrics: mergeMetrics({ live, stored: doc.samples, nodes: doc.nodes }), doc };
}

/**
 * Every node's host-measured usage, keyed by node id.
 *
 * The DAG document names each node's child session in `agent`; this walks it and
 * asks each session's projections for their live numbers, falling back to the
 * node's persisted sample. A node without an agent, with nothing readable and
 * without a stored sample is left out entirely, so the panel can iterate the
 * result without a presence check.
 *
 * @param input - the session whose DAG to read, plus the host services.
 * @returns the metrics of every node that has at least one of them; `{}` when
 *   the document is missing/unreadable or nothing could be measured.
 */
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
 * @param sessionId - the owning (root) session id.
 * @param nodeId - the node the measurement belongs to.
 * @param metrics - what the host just measured; an empty or malformed reading is ignored.
 */
export function rememberMeasurement(
  sessionId: string,
  nodeId: string,
  metrics: DagNodeMetrics
): void {
  // `0` is a throwaway stamp: only a *stored* sample carries `at`, so the value
  // is only used to run the shared validation over the two numbers.
  const kept = sampleOf(metrics, 0);
  if (kept === undefined) return;
  const entry: DagNodeMetrics = {};
  if (kept.tokens !== undefined) entry.tokens = kept.tokens;
  if (kept.elapsed_ms !== undefined) entry.elapsed_ms = kept.elapsed_ms;
  const entries = measurements.get(sessionId) ?? new Map<string, DagNodeMetrics>();
  measurements.set(sessionId, entries);
  // Deleting first makes the re-inserted pair the newest of the session.
  entries.delete(nodeId);
  entries.set(nodeId, entry);
  while (entries.size > MEASUREMENT_MAX) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) break;
    entries.delete(oldest);
  }
}

/**
 * The most recent remembered measurement for one node, if any.
 *
 * @param sessionId - the owning (root) session id.
 * @param nodeId - the node the measurement belongs to.
 */
export function lastMeasurement(sessionId: string, nodeId: string): DagNodeMetrics | undefined {
  const found = measurements.get(sessionId)?.get(nodeId);
  // A copy: the caller is about to stamp a sample with its own `at`, and must
  // not be able to rewrite the live reading that produced it.
  return found === undefined ? undefined : { ...found };
}

/**
 * Test seam: forget everything (one session's entries when `sessionId` is given).
 *
 * @param sessionId - the session to forget; absent forgets every session.
 */
export function clearMeasurements(sessionId?: string): void {
  if (sessionId === undefined) {
    measurements.clear();
    return;
  }
  measurements.delete(sessionId);
}
