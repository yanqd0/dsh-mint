/**
 * plan DAG tab 的 body（spec: `notes/plan-dag.md`）：一个文档一张 SVG——节点是 `dag-model` 的盒子、
 * 边是它的折线、状态配色用与模型测试同一套 tone 函数；组件只持模型管不了的三件事：何时读
 * （可见性 + 2s 轮询）、宿主样本如何老化成实时时钟（1s tick，只在有东西真在跑时）、hover 显示什么。
 *
 * 轮询只在答案的 revision 或它带的样本变了才替换状态：安静的计划图保持不动，仍在跑的节点继续走。
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

const POLL_MS = 2000;

const TICK_MS = 1000;

/**
 * 节点盒子里两条文本基线，从盒子顶部量起。盒子做成 44 高正是为此：标签占第一行、测量对占第二行，
 * 两行都居中，故这两个常量无论标签自身的度量如何都相隔一行。
 */
const NODE_LABEL_DY = 16;
const NODE_METRICS_DY = 32;

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
  // 面板最后接受的一次读数。用 ref 而非 state：它守的是一次写入、从不作画；而且它同时记住样本与
  // revision，因为文档不动时数字仍在变。
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
        // 整份 payload 进 state——上面的守卫只为跳过写入，从不把旧样本并进新样本。失败的答案忘掉
        // 读数，这样恢复后的会话不会被误判成「同一样本」而一直停在提示上。
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
  // 只有真有 running 节点在活时，时钟才值得起定时器：只读到存量样本的节点不在累加，每次 tick
  // 都只会重画同一张图（它的行显示存量数字，日期在卡片里）。
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
