/**
 * DAG 面板的纯逻辑：把一次作答归约成「可比较的读数」与「可绘制的时间」。
 *
 * 与 `DagBody.tsx` 分开是为了让这一族（轮询守卫的比较、样本老化）留在 `.ts`：
 * `.tsx` 组件不进覆盖口径，而这里的每一支都是可测的分支。
 */
import type { DagNodeMetrics, DagNodeView, MintDagPayload } from '../shared/records.js';
import { liveElapsedMs, nodeMetricsMap } from './dag-model.js';

/**
 * What one answer's identity consists of.
 *
 * The revision says whether the file moved; the sample says whether the numbers
 * did. Both are needed to tell "the same reading twice" from "the same document,
 * freshly measured".
 */
export interface DagSample {
  revision: number;
  sampledAt: number | undefined;
  metrics: Record<string, DagNodeMetrics> | undefined;
}

/** The guard's memory of one answered payload. */
export function sampleOf(payload: MintDagPayload): DagSample {
  return { revision: payload.revision, sampledAt: payload.sampled_at, metrics: payload.metrics };
}

/**
 * Whether two answers are the same reading of the document.
 *
 * Only when both the revision and the sample are unchanged is re-setting the
 * state pure redraw work: the same graph and the same numbers, at the cost of a
 * render. The maps are small and flat, so comparing them field by field is both
 * cheaper and more precise than a serialized form.
 */
export function sameSample(previous: DagSample | undefined, next: DagSample): boolean {
  if (previous === undefined) return false;
  if (previous.revision !== next.revision) return false;
  if (previous.sampledAt !== next.sampledAt) return false;
  return sameMetrics(previous.metrics, next.metrics);
}

/** Field-by-field equality of two samples, keyed by node id. */
function sameMetrics(
  before: Record<string, DagNodeMetrics> | undefined,
  after: Record<string, DagNodeMetrics> | undefined
): boolean {
  if (before === after) return true;
  if (before === undefined || after === undefined) return false;
  const ids = Object.keys(before);
  if (ids.length !== Object.keys(after).length) return false;
  return ids.every(
    (id) =>
      before[id]?.tokens === after[id]?.tokens && before[id]?.elapsed_ms === after[id]?.elapsed_ms
  );
}

/**
 * The per-node measurements a payload may be drawn from, already filtered.
 *
 * `nodeMetricsMap` drops what the document no longer carries and what a partial
 * sample got wrong; the branch on `metrics` is what keeps the call inside
 * `exactOptionalPropertyTypes`, where an explicit `undefined` is not the same as
 * an absent field.
 *
 * @param payload - the loaded answer, or `undefined` while it is not there yet.
 */
export function sampleMetrics(payload: MintDagPayload | undefined): Record<string, DagNodeMetrics> {
  if (payload?.metrics === undefined) return {};
  return nodeMetricsMap({ dag: payload.dag, metrics: payload.metrics });
}

/**
 * The elapsed time a node's line should draw right now.
 *
 * A running node is still moving: the host sampled its time once, and every
 * second since is the browser's own — which is exactly what `liveElapsedMs`
 * anchors on the sample's clock. A settled node's time is the sample itself: it
 * must not drift with `now`, because nothing is still accumulating.
 *
 * A *stored* sample (`at` present) is the one case where a running node stops
 * counting: the reading describes a child the host measured earlier — its
 * session is gone — so aging it on the browser clock would claim time this node
 * never ran. It is still shown, as the host's own number (`?` would hide a real
 * measurement), and the card dates it.
 *
 * @param node - the node whose line is drawn.
 * @param metrics - the host's last sample for that node, if any.
 * @param sampledAtMs - when that sample was taken, on the host's clock.
 * @param nowMs - the browser's current time.
 */
export function measuredTimeMs(
  node: DagNodeView,
  metrics: DagNodeMetrics | undefined,
  sampledAtMs: number | undefined,
  nowMs: number
): number | undefined {
  if (metrics?.at !== undefined) return metrics.elapsed_ms;
  if (node.status !== 'running') return metrics?.elapsed_ms;
  return liveElapsedMs(metrics?.elapsed_ms, sampledAtMs, nowMs);
}

/** A stored sample's stamp as the local clock reads it; the copy supplies the label. */
export function measuredAtLabel(at: number): string {
  return new Date(at).toLocaleTimeString();
}
