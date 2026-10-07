/**
 * Host-measured per-node usage for the plan DAG (#161).
 *
 * The DAG document only carries what a child *reports about itself*; this module
 * is the host's second opinion. It reads the child session's own projection
 * state and turns it into the two live fields the panel draws, and two rules
 * carry the whole design:
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
import { isRecord } from './mint-json.js';
import type { DagNodeMetrics, DagStatus } from './records.js';
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
export interface DagMetricsInput {
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

/**
 * Every node's host-measured usage, keyed by node id.
 *
 * The DAG document names each node's child session in `agent`; this walks it and
 * asks each session's projections for their live numbers. A node without an
 * agent, without a live session, or with nothing readable is left out entirely,
 * so the panel can iterate the result without a presence check.
 *
 * @param input - the session whose DAG to read, plus the host services.
 * @returns the metrics of every node that has at least one of them; `{}` when
 *   the composition has no projections, the document is missing/unreadable, or
 *   nothing could be measured.
 */
export async function readDagMetrics(
  input: DagMetricsInput
): Promise<Record<string, DagNodeMetrics>> {
  const { projections } = input;
  if (projections === undefined) return {};
  const read = await readDag(input.sessionId, input.dagDir ?? DAG_DIR);
  if (read.state !== 'ok' || read.doc.nodes.length === 0) return {};
  const metrics: Record<string, DagNodeMetrics> = {};
  for (const node of read.doc.nodes) {
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
    if (Object.keys(found).length > 0) metrics[node.id] = found;
  }
  return metrics;
}
