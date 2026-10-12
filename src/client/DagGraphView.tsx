/**
 * plan DAG 视图（第一个视图）：一个文档一张 SVG——节点是 `dag-model` 的盒子、边是它的折线、
 * 状态配色用与模型测试同一套 tone 函数。
 *
 * 从 `DagBody.tsx` 拆出后它只负责**画**：读那一半（可见性 + 2s 轮询 + 整份读数守卫）、两个视图
 * 之间的切换、以及图层推进方向都归 `DagBody.tsx`（面板容器）。组件仍然自己管三件事：hover 是谁、
 * 1s 走秒的本地时钟、以及挂/卸那个 `running` 脉动 class 的 keyframes。
 */
import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';

import type { MintDagPayload } from '../shared/records.js';
import { NodeMetricsLine, NodeTooltip } from './NodeCard.js';
import { StateNotice } from './StateNotice.js';
import type { DagDirection } from './dag-model.js';
import {
  DAG_STAGE_PAD,
  dagCounts,
  dagTone,
  isRunning,
  layoutDag,
  stageHeadline,
} from './dag-model.js';
import { sampleMetrics } from './dag-sampler.js';
import type { LoadState } from './model.js';
import {
  DAG_CANVAS,
  DAG_NODE_LABEL,
  DAG_RUNNING_CLASS,
  DAG_STAGE_LABEL,
  NOTE,
  dagNodeStyle,
  dagStageStyle,
} from './styles.js';
import type { MintBodyProps } from './types.js';

const TICK_MS = 1000;

/**
 * 节点盒子里两条文本基线，从盒子顶部量起。盒子做成 44 高正是为此：标签占第一行、测量对占第二行，
 * 两行都居中，故这两个常量无论标签自身的度量如何都相隔一行。
 */
const NODE_LABEL_DY = 16;
const NODE_METRICS_DY = 32;

/** 这一视图的 keyframes：只有它自己的节点会挂那个 class，故注入一次即可。 */
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

export interface DagGraphViewProps extends MintBodyProps {
  state: LoadState<MintDagPayload>;
  /** 面板此刻是否正画着这个视图：隐藏的视图不起走秒定时器。 */
  active: boolean;
  /** 图层推进方向：由容器持有并下传，视图只照它画。 */
  direction: DagDirection;
}

export function DagGraphView({ copy, state, active, direction }: DagGraphViewProps): ReactElement {
  const [hovered, setHovered] = useState<string | undefined>(undefined);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const payload = state.status === 'ready' ? state.value : undefined;
  const metrics = sampleMetrics(payload);
  const sampledAtMs = payload?.sampled_at;
  // 只有真有 running 节点在活时，时钟才值得起定时器：只读到存量样本的节点不在累加，每次 tick
  // 都只会重画同一张图（它的行显示存量数字，日期在卡片里）。
  const liveClock =
    active &&
    (payload?.dag?.nodes.some(
      (node) =>
        node.status === 'running' &&
        metrics[node.id]?.at === undefined &&
        metrics[node.id]?.elapsed_ms !== undefined
    ) ??
      false);

  useEffect(() => {
    if (!liveClock) return;
    // 第一次 tick 把 `now` 重新锚到浏览器钟上，于是这一行从样本的年龄开始走，而不是从组件
    // 挂载的那一刻。
    setNowMs(Date.now());
    const timer = setInterval(() => {
      setNowMs(Date.now());
    }, TICK_MS);
    return () => {
      clearInterval(timer);
    };
  }, [liveClock]);

  if (state.status === 'loading') return <StateNotice copy={copy} state="loading" />;
  if (state.status === 'failed') {
    // 失败与重试归容器（它才有 `api` 与刷新命令）；这里只如实说出状态。
    return <StateNotice copy={copy} state="failed" message={state.message} stderr={state.stderr} />;
  }

  const { dag, file, warnings } = state.value;

  // 没有可读文档：要么本会话从来没有过（正常态），要么文件存在却解析不了——那时点名它读不动的
  // 路径，而不是让读者以为面板坏了。
  if (dag === null) {
    return (
      <>
        <p style={{ ...NOTE, padding: '8px 10px' }}>
          {warnings === undefined || warnings.length === 0
            ? copy('dag.empty')
            : copy('dag.unreadable')}
        </p>
        {warnings !== undefined && warnings.length > 0 && (
          <p style={{ ...NOTE, padding: '0 10px 8px' }}>{copy('dag.file', { path: file })}</p>
        )}
      </>
    );
  }

  const layout = layoutDag(dag, direction);
  const counts = dagCounts(dag);
  const hoveredNode = dag.nodes.find((node) => node.id === hovered);

  return (
    <>
      <style>{KEYFRAMES}</style>
      <div style={{ ...NOTE, padding: '4px 10px' }}>
        {copy('dag.count', { nodes: counts.nodes, edges: counts.edges })} ·{' '}
        {copy('dag.runningCount', { count: counts.running })}
      </div>
      <div style={DAG_CANVAS}>
        <svg
          width={layout.width}
          height={layout.height}
          viewBox={`0 0 ${String(layout.width)} ${String(layout.height)}`}
          role="img"
          aria-label={copy('dag.type.label')}
        >
          {/* 阶段带先画：它是背景分区，边与节点都落在带里。 */}
          {layout.bands.map((band) => (
            <g key={band.phase}>
              <rect
                x={band.x}
                y={band.y}
                width={band.w}
                height={band.h}
                rx={8}
                style={dagStageStyle()}
              />
              <text x={band.x + DAG_STAGE_PAD} y={band.y + 12} style={DAG_STAGE_LABEL}>
                {stageHeadline(copy, band.phase, band.count)}
              </text>
            </g>
          ))}
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
    </>
  );
}
