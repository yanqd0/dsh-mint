/**
 * The plan DAG tab's body (plan #31 §4.3–4.6).
 *
 * One SVG per document: nodes are `dag-model`'s boxes, edges its polylines, and
 * the status coloring comes from the same tone function the model tests cover.
 * The component owns only two things the model cannot: when to read (the tab's
 * visibility and its 2s poll) and what hover shows.
 *
 * The poll replaces the state only when the answered `revision` changed, so a
 * session with a quiet plan does not re-render its graph every two seconds.
 */
import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactElement } from 'react';

import type { DagNodeView, DagVerdict, MintDagPayload } from '../records.js';
import { StateNotice } from './StateNotice.js';
import { dagCounts, dagTone, isRunning, layoutDag } from './dag-model.js';
import type { LoadState } from './model.js';
import { toLoadState } from './model.js';
import {
  DAG_CANVAS,
  DAG_NODE_LABEL,
  DAG_RUNNING_CLASS,
  DAG_SHELL,
  DAG_TOOLTIP,
  DAG_TOOLTIP_META,
  NOTE,
  TOOLBAR,
  dagNodeStyle,
} from './styles.js';
import type { MintBodyProps, TabInfoLike } from './types.js';

/** How often a visible DAG tab re-reads the document (spec §4.6). */
const POLL_MS = 2000;

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
  const revision = useRef<number | undefined>(undefined);

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
        // An unchanged revision means the document did not move: re-setting the
        // state would re-render the same graph and drop an open tooltip.
        if (response.ok && response.revision === revision.current) return;
        if (response.ok) revision.current = response.revision;
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

  // The tab's own refresh command: an explicit read bypasses the revision guard.
  useEffect(() => {
    if (actions === undefined) return;
    return actions.bindCommands({
      refresh: () => {
        revision.current = undefined;
        setReload((count) => count + 1);
      },
    });
  }, [actions]);

  if (state.status === 'loading') return <StateNotice copy={copy} state="loading" />;
  if (state.status === 'failed') {
    return (
      <StateNotice
        copy={copy}
        state="failed"
        message={state.message}
        stderr={state.stderr}
        onRetry={() => {
          revision.current = undefined;
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
          {warnings === undefined || warnings.length === 0 ? copy('dag.empty') : copy('dag.unreadable')}
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
                  y={box.y + box.h / 2}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  style={DAG_NODE_LABEL}
                >
                  {node.label}
                </text>
              </g>
            );
          })}
        </svg>
        {hoveredNode !== undefined && (
          <NodeTooltip node={hoveredNode} copy={copy} layout={layout} />
        )}
      </div>
    </div>
  );
}

/** What one node's tooltip needs: the node, the copy seat, and the geometry. */
interface NodeTooltipProps {
  node: DagNodeView;
  copy: MintBodyProps['copy'];
  layout: ReturnType<typeof layoutDag>;
}

/**
 * The hover card: the node's full text, then the fields a reader would otherwise
 * have to ask the tool for.
 */
function NodeTooltip({ node, copy, layout }: NodeTooltipProps): ReactElement {
  const box = layout.boxes.find((candidate) => candidate.id === node.id);
  const left = box === undefined ? 0 : box.x;
  const top = box === undefined ? 0 : box.y + box.h + 4;
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
      {node.tokens !== undefined && (
        <p style={TOOLTIP_LINE}>{copy('dag.tokens', { tokens: node.tokens })}</p>
      )}
      {node.note !== undefined && (
        <>
          <p style={{ ...TOOLTIP_LINE, ...DAG_TOOLTIP_META }}>{copy('dag.note')}</p>
          <p style={TOOLTIP_LINE}>{node.note}</p>
        </>
      )}
      <p style={{ ...TOOLTIP_LINE, ...DAG_TOOLTIP_META }}>
        {`${copy('dag.node.id', { id: node.id })} · ${phaseLabel(copy, node.phase)} · ${statusLabel(copy, node.status)}${
          node.verdict === undefined ? '' : ` · ${verdictLabel(copy, node.verdict)}`
        }`}
      </p>
    </div>
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
