/**
 * The plan DAG tab's body (spec: `notes/plan-dag.md`).
 *
 * One SVG per document: nodes are `dag-model`'s boxes, edges its polylines, and
 * the status coloring comes from the same tone function the model tests cover.
 * The component owns only three things the model cannot: when to read (the tab's
 * visibility and its 2s poll), how a host sample is aged into a live clock (a 1s
 * tick, running only while something is), and what hover shows.
 *
 * The poll replaces the state only when the answered revision or the sample it
 * carried changed, so a quiet plan keeps its graph, while a node that is still
 * running keeps moving.
 */
import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactElement } from 'react';

import type {
  DagNodeMetrics,
  DagNodeView,
  DagVerdict,
  DagWorktreeState,
  MintDagPayload,
} from '../shared/records.js';
import { StateNotice } from './StateNotice.js';
import {
  DAG_COPY_KEYS,
  dagCounts,
  dagStatusTone,
  dagTone,
  dagWorktreeTone,
  formatCount,
  formatSeconds,
  isRunning,
  layoutDag,
  liveElapsedMs,
  nodeMetricsMap,
} from './dag-model.js';
import type { LoadState } from './model.js';
import { toLoadState } from './model.js';
import {
  DAG_CANVAS,
  DAG_NODE_LABEL,
  DAG_NODE_METRICS,
  DAG_RUNNING_CLASS,
  DAG_SHELL,
  DAG_TOOLTIP,
  DAG_TOOLTIP_META,
  LIVE_TIME_COLOR,
  LIVE_TOKENS_COLOR,
  NOTE,
  TOOLBAR,
  dagLiveTimeStyle,
  dagLiveTokensStyle,
  dagNodeStyle,
  pill,
} from './styles.js';
import type { MintBodyProps, TabInfoLike } from './types.js';

/** How often a visible DAG tab re-reads the document (spec §4.6). */
const POLL_MS = 2000;

/** How often the live line re-derives a running node's elapsed time. */
const TICK_MS = 1000;

/**
 * The two text baselines inside a node box, measured from the box's top.
 *
 * The box is 44 tall for exactly this: the label takes the first line and the
 * measured pair the second, and both are centered, so the two constants are one
 * line apart whatever the label's own metrics turn out to be.
 */
const NODE_LABEL_DY = 16;
const NODE_METRICS_DY = 32;

/** The token unit inside a node box: the box is 104 wide and the label 12px. */
const TOKEN_UNIT = 't';

/** What sits between the two measured numbers, in the secondary color. */
const METRICS_SEPARATOR = ' · ';

/** A running node whose sample has not arrived: a time is coming, none is known. */
const TIME_PENDING = '?';

/** A settled node with nothing measured: there is nothing left to wait for. */
const TIME_NONE = '-';

/** Units and separators: legible, but never in a measured number's own color. */
const METRICS_SECONDARY: CSSProperties = {
  fill: 'var(--dsw-alias-label-secondary)',
};

/** The pulse the running node's border runs; injected once, next to the node. */
const KEYFRAMES = `
@keyframes dsh-mint-dag-pulse {
  0%, 100% { stroke-opacity: 1; }
  50% { stroke-opacity: 0.25; }
}
.${DAG_RUNNING_CLASS} { animation: dsh-mint-dag-pulse 1.2s ease-in-out infinite; }
@media (prefers-reduced-motion: reduce) {
  .${DAG_RUNNING_CLASS} { animation: none; }
}
`;

/** The seat's hook; a stable no-op keeps the call unconditional in lean harnesses. */
const NO_TAB_INFO = (): TabInfoLike | undefined => undefined;

/** The full title is the tooltip's headline; it wraps instead of clipping. */
const TOOLTIP_TITLE: CSSProperties = {
  margin: '0 0 4px',
  fontWeight: 500,
};

/** One tooltip line; `margin: 0` keeps the block tight against the box. */
const TOOLTIP_LINE: CSSProperties = {
  margin: 0,
};

/** The card's chip row: what the node is doing, and the issue it tracks. */
const TOOLTIP_BADGES: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  flexWrap: 'wrap',
  margin: '0 0 4px',
};

/** A unit, a source note, or any other quiet text inside the card (DOM, so `color`). */
const TOOLTIP_QUIET: CSSProperties = {
  color: 'var(--dsw-alias-label-secondary)',
};

/**
 * What one answer's identity consists of.
 *
 * The revision says whether the file moved; the sample says whether the numbers
 * did. Both are needed to tell "the same reading twice" from "the same document,
 * freshly measured".
 */
interface DagSample {
  revision: number;
  sampledAt: number | undefined;
  metrics: Record<string, DagNodeMetrics> | undefined;
}

/** The guard's memory of one answered payload. */
function sampleOf(payload: MintDagPayload): DagSample {
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
function sameSample(previous: DagSample | undefined, next: DagSample): boolean {
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
function sampleMetrics(payload: MintDagPayload | undefined): Record<string, DagNodeMetrics> {
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
function measuredTimeMs(
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
function measuredAtLabel(at: number): string {
  return new Date(at).toLocaleTimeString();
}

/**
 * Render the DAG panel.
 *
 * @param props - session identity, copy, transport, and the seat's tab hook.
 */
export function DagBody(props: MintBodyProps): ReactElement {
  const { api, copy, useTabInfo = NO_TAB_INFO } = props;
  const info = useTabInfo();
  const signal = info?.tab.signal;
  const visible = info?.tab.visible ?? true;
  const actions = info?.tab.actions;

  const [state, setState] = useState<LoadState<MintDagPayload>>({ status: 'loading' });
  const [hovered, setHovered] = useState<string | undefined>(undefined);
  const [reload, setReload] = useState(0);
  const [nowMs, setNowMs] = useState(() => Date.now());
  // The last reading the panel accepted. It is a ref rather than state because
  // it guards a write, it never draws; and it remembers the sample as well as
  // the revision, since the numbers move while the document does not.
  const lastSample = useRef<DagSample | undefined>(undefined);

  useEffect(() => {
    if (!visible || signal?.aborted === true) return;
    const controller = new AbortController();
    const abort = (): void => {
      controller.abort();
    };
    signal?.addEventListener('abort', abort);
    const read = (): void => {
      void api.dag(controller.signal).then((response) => {
        if (controller.signal.aborted) return;
        // The same document measured into the same numbers: re-setting the state
        // would re-render the same graph and drop an open tooltip for nothing.
        if (response.ok && sameSample(lastSample.current, sampleOf(response))) return;
        // The whole payload is carried into the state — the guard above is about
        // skipping writes, never about merging a stale sample into a fresh one.
        // A failed answer forgets the reading, so a recovered session is never
        // mistaken for "the same sample" and left on the notice.
        lastSample.current = response.ok ? sampleOf(response) : undefined;
        setState(toLoadState(response));
      });
    };
    read();
    const timer = setInterval(read, POLL_MS);
    return () => {
      signal?.removeEventListener('abort', abort);
      controller.abort();
      clearInterval(timer);
    };
  }, [api, visible, signal, reload]);

  // The tab's own refresh command: an explicit read bypasses the guard.
  useEffect(() => {
    if (actions === undefined) return;
    return actions.bindCommands({
      refresh: () => {
        lastSample.current = undefined;
        setReload((count) => count + 1);
      },
    });
  }, [actions]);

  const payload = state.status === 'ready' ? state.value : undefined;
  const metrics = sampleMetrics(payload);
  const sampledAtMs = payload?.sampled_at;
  // The clock is only worth a timer while a running node is genuinely live: a
  // node whose only reading is a stored sample is not accumulating, so every
  // tick would redraw the same picture (its line shows the stored number, dated
  // in the card).
  const liveClock =
    payload?.dag?.nodes.some(
      (node) =>
        node.status === 'running' &&
        metrics[node.id]?.at === undefined &&
        metrics[node.id]?.elapsed_ms !== undefined
    ) ?? false;

  useEffect(() => {
    if (!visible || !liveClock) return;
    // The first tick re-anchors `now` on the browser clock, so the line starts
    // from the sample's age rather than from whenever the component mounted.
    setNowMs(Date.now());
    const timer = setInterval(() => {
      setNowMs(Date.now());
    }, TICK_MS);
    return () => {
      clearInterval(timer);
    };
  }, [visible, liveClock]);

  if (state.status === 'loading') return <StateNotice copy={copy} state="loading" />;
  if (state.status === 'failed') {
    return (
      <StateNotice
        copy={copy}
        state="failed"
        message={state.message}
        stderr={state.stderr}
        onRetry={() => {
          lastSample.current = undefined;
          setReload((count) => count + 1);
        }}
      />
    );
  }

  const { dag, file, warnings } = state.value;

  // No readable document: either this session never had one (the normal state),
  // or the file exists and could not be parsed — which names the path it failed
  // on instead of reading as a bug in the panel.
  if (dag === null) {
    return (
      <div style={DAG_SHELL}>
        <p style={{ ...NOTE, padding: '8px 10px' }}>
          {warnings === undefined || warnings.length === 0
            ? copy('dag.empty')
            : copy('dag.unreadable')}
        </p>
        {warnings !== undefined && warnings.length > 0 && (
          <p style={{ ...NOTE, padding: '0 10px 8px' }}>{copy('dag.file', { path: file })}</p>
        )}
      </div>
    );
  }

  const layout = layoutDag(dag);
  const counts = dagCounts(dag);
  const hoveredNode = dag.nodes.find((node) => node.id === hovered);

  return (
    <div style={DAG_SHELL}>
      {/* The keyframes belong to the SVG below them; one copy per pane is enough. */}
      <style>{KEYFRAMES}</style>
      <div style={TOOLBAR}>
        <span style={NOTE}>{copy('dag.count', { nodes: counts.nodes, edges: counts.edges })}</span>
        <span style={NOTE}>{copy('dag.runningCount', { count: counts.running })}</span>
      </div>
      <div style={DAG_CANVAS}>
        <svg
          width={layout.width}
          height={layout.height}
          viewBox={`0 0 ${String(layout.width)} ${String(layout.height)}`}
          role="img"
          aria-label={copy('dag.type.label')}
        >
          {layout.edges.map((edge) => (
            <polyline
              key={`${edge.from}->${edge.to}`}
              points={edge.points}
              fill="none"
              stroke="var(--dsw-alias-border-l2)"
              strokeWidth={1.5}
            />
          ))}
          {layout.boxes.map((box) => {
            const node = dag.nodes.find((candidate) => candidate.id === box.id);
            if (node === undefined) return null;
            return (
              <g
                key={box.id}
                tabIndex={0}
                role="button"
                aria-label={node.title}
                onMouseEnter={() => {
                  setHovered(box.id);
                }}
                onMouseLeave={() => {
                  setHovered(undefined);
                }}
                onFocus={() => {
                  setHovered(box.id);
                }}
                onBlur={() => {
                  setHovered(undefined);
                }}
              >
                <rect
                  x={box.x}
                  y={box.y}
                  width={box.w}
                  height={box.h}
                  rx={6}
                  style={dagNodeStyle(dagTone(node))}
                  className={isRunning(node) ? DAG_RUNNING_CLASS : undefined}
                />
                <text
                  x={box.x + box.w / 2}
                  y={box.y + NODE_LABEL_DY}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  style={DAG_NODE_LABEL}
                >
                  {node.label}
                </text>
                <NodeMetricsLine
                  node={node}
                  metrics={metrics[box.id]}
                  sampledAtMs={sampledAtMs}
                  nowMs={nowMs}
                  copy={copy}
                  x={box.x + box.w / 2}
                  y={box.y + NODE_METRICS_DY}
                />
              </g>
            );
          })}
        </svg>
        {hoveredNode !== undefined && (
          <NodeTooltip
            node={hoveredNode}
            copy={copy}
            layout={layout}
            metrics={metrics[hoveredNode.id]}
            sampledAtMs={sampledAtMs}
            nowMs={nowMs}
          />
        )}
      </div>
    </div>
  );
}

/** What one node box's measured line needs: the node, its sample, and the clock. */
interface NodeMetricsLineProps {
  node: DagNodeView;
  metrics: DagNodeMetrics | undefined;
  sampledAtMs: number | undefined;
  nowMs: number;
  copy: MintBodyProps['copy'];
  x: number;
  y: number;
}

/**
 * The second line inside a node box: what the host measured, in the box's colors.
 *
 * Each number keeps its own fill — amber for the tokens, purple for the time —
 * while the units and the separator stay in the secondary label color, so the
 * line reads as two numbers rather than as one sentence. The token unit is a
 * lone `t`: the box is 104 wide, and a spelled-out `tokens` would be the whole
 * line by itself.
 *
 * A `pending` node has no agent yet and therefore nothing to measure, so it
 * draws no line at all. A running node draws `?` in the time slot until a *live*
 * sample arrives (a time is coming, none is known) — a stored one is dated, not
 * running, so it shows the same `?`; a settled node with nothing in it draws `-`
 * (there is nothing left to wait for), and a settled node that only ever
 * reported tokens draws just those.
 */
function NodeMetricsLine({
  node,
  metrics,
  sampledAtMs,
  nowMs,
  copy,
  x,
  y,
}: NodeMetricsLineProps): ReactElement | null {
  if (node.status === 'pending') return null;
  const tokens = metrics?.tokens;
  const elapsed = measuredTimeMs(node, metrics, sampledAtMs, nowMs);
  // The placeholder is only for a slot that exists: a settled node showing
  // nothing but its tokens has no time slot to fill.
  let placeholder: string | undefined;
  if (elapsed === undefined) {
    if (node.status === 'running') placeholder = TIME_PENDING;
    else if (tokens === undefined) placeholder = TIME_NONE;
  }

  const parts: ReactElement[] = [];
  if (tokens !== undefined) {
    parts.push(
      <tspan key="tokens" style={dagLiveTokensStyle()}>
        {formatCount(tokens)}
      </tspan>,
      <tspan key="tokens-unit" style={METRICS_SECONDARY}>
        {TOKEN_UNIT}
      </tspan>
    );
  }
  if (elapsed !== undefined) {
    if (parts.length > 0) {
      parts.push(
        <tspan key="separator" style={METRICS_SECONDARY}>
          {METRICS_SEPARATOR}
        </tspan>
      );
    }
    parts.push(
      <tspan key="time" style={dagLiveTimeStyle()}>
        {formatSeconds(elapsed)}
      </tspan>,
      <tspan key="time-unit" style={METRICS_SECONDARY}>
        {copy(DAG_COPY_KEYS.seconds)}
      </tspan>
    );
  } else if (placeholder !== undefined) {
    if (parts.length > 0) {
      parts.push(
        <tspan key="separator" style={METRICS_SECONDARY}>
          {METRICS_SEPARATOR}
        </tspan>
      );
    }
    parts.push(
      <tspan key="time" style={METRICS_SECONDARY}>
        {placeholder}
      </tspan>
    );
  }
  if (parts.length === 0) return null;

  return (
    <text x={x} y={y} textAnchor="middle" dominantBaseline="middle" style={DAG_NODE_METRICS}>
      {parts}
    </text>
  );
}

/** What one node's tooltip needs: the node, its sample, the clock, and the geometry. */
interface NodeTooltipProps {
  node: DagNodeView;
  copy: MintBodyProps['copy'];
  layout: ReturnType<typeof layoutDag>;
  metrics: DagNodeMetrics | undefined;
  sampledAtMs: number | undefined;
  nowMs: number;
}

/**
 * The hover card: the node's full text, then the fields a reader would otherwise
 * have to ask the tool for.
 *
 * The status and the verdict sit in the chip row, because the footer is the
 * quiet line; the measured numbers keep the colors the node box gave them, so
 * the card and the box read as one reading of the node. A card is DOM, not SVG:
 * the same palette is applied through `color`, not `fill`.
 *
 * The time line is also where a *stored* reading gets its date: the
 * number beside it was measured when the child was alive, so the card names that
 * moment in the local clock instead of letting the reader take it for now.
 *
 * The node's isolated working tree, when it has one, is the card's other chip
 * row: the state is colored like a status pill, and the branch it works
 * on sits beside it. Nothing here touches git or the file system — the branch,
 * the state and the path are all the route's own fields.
 */
function NodeTooltip({
  node,
  copy,
  layout,
  metrics,
  sampledAtMs,
  nowMs,
}: NodeTooltipProps): ReactElement {
  const box = layout.boxes.find((candidate) => candidate.id === node.id);
  const left = box === undefined ? 0 : box.x;
  const top = box === undefined ? 0 : box.y + box.h + 4;
  // Both chips answer what the node is doing, so both take the badge's tone; the
  // box underneath keeps its own axis (`dagTone`).
  const tone = dagStatusTone(node);
  const tokens = metrics?.tokens;
  const elapsed = measuredTimeMs(node, metrics, sampledAtMs, nowMs);
  const duration = elapsed === undefined ? undefined : formatSeconds(elapsed);
  const measuredAt = metrics?.at;
  const worktree = node.worktree;
  return (
    <div
      style={{
        ...DAG_TOOLTIP,
        left,
        top,
        // Keep the card inside the canvas width where the viewport allows it.
        maxWidth: Math.max(160, layout.width - left),
      }}
      role="tooltip"
    >
      <p style={TOOLTIP_TITLE}>{node.title}</p>
      <p style={TOOLTIP_BADGES}>
        <span style={pill(tone)}>{statusLabel(copy, node.status)}</span>
        {node.verdict !== undefined && (
          <span style={pill(tone)}>{verdictLabel(copy, node.verdict)}</span>
        )}
        {node.issue !== undefined && (
          <span style={DAG_TOOLTIP_META}>{`#${String(node.issue)}`}</span>
        )}
      </p>
      {worktree !== undefined && (
        <p style={TOOLTIP_BADGES}>
          <span style={pill(dagWorktreeTone(worktree.state))}>
            {worktreeStateLabel(copy, worktree.state)}
          </span>
          {/* The path is the worktree's own identity, and too long for the card:
              the native hover text carries it without spending a line on it. */}
          <span style={DAG_TOOLTIP_META} title={worktree.path}>
            {copy('dag.worktree.branch', { branch: worktree.branch })}
          </span>
        </p>
      )}
      {tokens === undefined ? (
        // Nothing was measured: the node's own report is all there is, and it is
        // shown without the measure's color or source note — it is not one.
        node.tokens !== undefined && (
          <p style={TOOLTIP_LINE}>{copy('dag.tokens', { tokens: node.tokens })}</p>
        )
      ) : (
        <p style={TOOLTIP_LINE}>
          <LiveTokensLine copy={copy} tokens={tokens} />
        </p>
      )}
      {duration !== undefined && (
        <p style={TOOLTIP_LINE}>
          <span style={{ color: LIVE_TIME_COLOR }}>{duration}</span>{' '}
          <span style={TOOLTIP_QUIET}>{copy(DAG_COPY_KEYS.seconds)}</span>
          {/* A stored reading is dated: the card says *when*, because the number
              it shows is what the host measured then, not what it reads now. */}
          {measuredAt !== undefined && (
            <span style={TOOLTIP_QUIET}>
              {' '}
              {copy(DAG_COPY_KEYS.measuredAt, { at: measuredAtLabel(measuredAt) })}
            </span>
          )}
        </p>
      )}
      {node.note !== undefined && (
        <>
          <p style={{ ...TOOLTIP_LINE, ...DAG_TOOLTIP_META }}>{copy('dag.note')}</p>
          <p style={TOOLTIP_LINE}>{node.note}</p>
        </>
      )}
      <p style={{ ...TOOLTIP_LINE, ...DAG_TOOLTIP_META }}>
        {`${copy('dag.node.id', { id: node.id })} · ${phaseLabel(copy, node.phase)}`}
      </p>
    </div>
  );
}

/** What the card's measured token line needs: the count and the copy seat. */
interface LiveTokensLineProps {
  copy: MintBodyProps['copy'];
  tokens: number;
}

/**
 * The card's measured token count, colored inside its own translated line.
 *
 * The dictionary's live line is one string with the count interpolated into it
 * (`{tokens} tokens (measured)`), and only the count may take the measure's
 * color — the unit and the source note stay secondary. The line is therefore
 * split around the number it interpolated, which is exact: neither locale's
 * surrounding text carries a digit of its own.
 */
function LiveTokensLine({ copy, tokens }: LiveTokensLineProps): ReactElement {
  const count = formatCount(tokens);
  const line = copy(DAG_COPY_KEYS.liveTokens, { tokens: count });
  const at = line.indexOf(count);
  const before = at < 0 ? '' : line.slice(0, at);
  const after = at < 0 ? line : line.slice(at + count.length);
  return (
    <>
      {before !== '' && <span style={TOOLTIP_QUIET}>{before}</span>}
      <span style={{ color: LIVE_TOKENS_COLOR }}>{count}</span>
      <span style={TOOLTIP_QUIET}>{after}</span>
    </>
  );
}

/**
 * The copies of a node's two enumerated fields.
 *
 * Enumerated values stay English in both locales (mint's own vocabulary, like
 * `Issue` / `Plan`), and switching on the value keeps every `dag.*` key a
 * literal — the dictionary's "every key is asked for" guard is textual.
 */
function phaseLabel(copy: MintBodyProps['copy'], phase: DagNodeView['phase']): string {
  switch (phase) {
    case 'research':
      return copy('dag.phase.research');
    case 'exec':
      return copy('dag.phase.exec');
  }
}

/** As {@link phaseLabel}, for a node's lifecycle state. */
function statusLabel(copy: MintBodyProps['copy'], status: DagNodeView['status']): string {
  switch (status) {
    case 'pending':
      return copy('dag.status.pending');
    case 'running':
      return copy('dag.status.running');
    case 'done':
      return copy('dag.status.done');
  }
}

/** As {@link phaseLabel}, for a settled node's outcome. */
function verdictLabel(copy: MintBodyProps['copy'], verdict: DagVerdict): string {
  switch (verdict) {
    case 'pass':
      return copy('dag.verdict.pass');
    case 'fail':
      return copy('dag.verdict.fail');
  }
}

/** As {@link phaseLabel}, for the state of a node's isolated working tree. */
function worktreeStateLabel(copy: MintBodyProps['copy'], state: DagWorktreeState): string {
  switch (state) {
    case 'active':
      return copy('dag.worktree.state.active');
    case 'merged':
      return copy('dag.worktree.state.merged');
    case 'conflict':
      return copy('dag.worktree.state.conflict');
    case 'removed':
      return copy('dag.worktree.state.removed');
  }
}
