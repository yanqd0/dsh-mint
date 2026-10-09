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
import type { ReactElement } from 'react';

import type { MintDagPayload } from '../shared/records.js';
import { StateNotice } from './StateNotice.js';
import { dagCounts, dagTone, isRunning, layoutDag } from './dag-model.js';
import type { LoadState } from './model.js';
import { toLoadState } from './model.js';
import {
  DAG_CANVAS,
  DAG_NODE_LABEL,
  DAG_RUNNING_CLASS,
  DAG_SHELL,
  NOTE,
  TOOLBAR,
  dagNodeStyle,
} from './styles.js';
import type { MintBodyProps, TabInfoLike } from './types.js';
import { NodeMetricsLine, NodeTooltip } from './NodeCard.js';
import type { DagSample } from './dag-sampler.js';
import { sameSample, sampleMetrics, sampleOf } from './dag-sampler.js';

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
