/**
 * 子代理树视图：一列盒子，缩进表示层级，肘线表示父子（规格见 `notes/agent-tree.md`）。
 *
 * 与 `DagGraphView` 的分工是刻意的：读那一半（2s 轮询 + 整份读数守卫 + 1s 走秒）都归
 * `DagBody.tsx` 的面板容器，两个视图各自只画自己的东西。共用的是**节点盒子的配色与 running
 * 脉动**（`dagNodeStyle` + `DAG_RUNNING_CLASS`）以及 token 黄 / 时长紫那两个测量色——两棵树因此
 * 读起来是同一套盒子。
 *
 * 画成 SVG（而不是 DOM 列表）正是为了这份一致：同样的圆角、同样的 `color-mix` 填充、同样的
 * 描边宽度，视图之间没有第二套视觉词汇。排版（含每格的文本）全在 `agent-tree-model.ts`，本文件
 * 只把它画出来。
 */
import type { CSSProperties, ReactElement } from 'react';

import type { MintAgentsPayload } from '../shared/records.js';
import type { CopyTranslate } from './copy.js';
import {
  AGENT_COPY_KEYS,
  AGENT_ROW_H,
  AGENT_ROW_GAP,
  agentStatusTone,
  agentTone,
  isAgentRunning,
  layoutAgentTree,
} from './agent-tree-model.js';
import type { AgentRowBox, AgentTreeLayout } from './agent-tree-model.js';
import {
  AGENT_ELBOW,
  AGENT_ROW_LABEL,
  AGENT_ROW_METRICS,
  DAG_CANVAS,
  DAG_RUNNING_CLASS,
  DAG_TOOLTIP,
  DAG_TOOLTIP_META,
  LIVE_TIME_COLOR,
  LIVE_TOKENS_COLOR,
  NOTE,
  agentRowStyle,
  pill,
} from './styles.js';

/** 悬停卡片在行下方偏移多少，避免盖住刚指的那一行。 */
const CARD_OFFSET = 4;

/** 肘线从父行底部起画的偏移（父行左边界 + 半个盒子的圆角）。 */
const ELBOW_INSET = 6;

/** 数字段之间的分隔符：与 DAG 节点那一行同一个记号。 */
const METRICS_SEPARATOR = ' · ';

/** 单位与分隔符走次级色，数字保留自己的测量色（与 DAG 节点内那一行同一个口径）。 */
const METRICS_SECONDARY: CSSProperties = {
  fill: 'var(--dsw-alias-label-secondary)',
};

interface CellProps {
  box: AgentRowBox;
}

/** 一行的数字格：上下文（黄）、总 token（黄，main 不画）、耗时（紫）。 */
function MetricsCells({ box }: CellProps): ReactElement {
  const { cells } = box;
  const parts: ReactElement[] = [];
  const cell = (key: string, text: string, color: string): void => {
    if (parts.length > 0) {
      parts.push(
        <tspan key={`${key}-sep`} style={METRICS_SECONDARY}>
          {METRICS_SEPARATOR}
        </tspan>
      );
    }
    parts.push(
      <tspan key={key} style={{ fill: color }}>
        {text}
      </tspan>
    );
  };
  if (cells.context !== undefined) cell('context', cells.context, LIVE_TOKENS_COLOR);
  if (cells.tokens !== undefined) cell('tokens', cells.tokens, LIVE_TOKENS_COLOR);
  if (cells.elapsed !== undefined) cell('elapsed', cells.elapsed, LIVE_TIME_COLOR);
  return (
    <text
      x={box.metricsRight}
      y={box.top + AGENT_ROW_H / 2}
      textAnchor="end"
      dominantBaseline="middle"
      style={AGENT_ROW_METRICS}
    >
      {parts}
    </text>
  );
}

interface CardProps {
  box: AgentRowBox;
  copy: CopyTranslate;
  layout: AgentTreeLayout;
  dagNodes: readonly string[];
}

/** 悬停卡片：这一行否则得去问工具的那些字段（完整 label、会话 id、对应的 DAG 节点）。 */
function AgentCard({ box, copy, layout, dagNodes }: CardProps): ReactElement {
  const node = box.row.node;
  return (
    <div
      style={{
        ...DAG_TOOLTIP,
        left: box.row.left,
        top: box.top + AGENT_ROW_H + CARD_OFFSET,
        maxWidth: Math.max(180, layout.width - box.row.left),
      }}
      role="tooltip"
    >
      <p style={{ margin: '0 0 4px', fontWeight: 500, wordBreak: 'break-word' }}>{node.label}</p>
      <p
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          flexWrap: 'wrap',
          margin: '0 0 4px',
        }}
      >
        <span style={pill(agentStatusTone(node))}>
          {copy(node.running ? 'dag.status.running' : 'dag.status.done')}
        </span>
        {node.mode !== undefined && <span style={DAG_TOOLTIP_META}>{node.mode}</span>}
        {node.kind === 'main' && <span style={DAG_TOOLTIP_META}>{copy(AGENT_COPY_KEYS.root)}</span>}
      </p>
      <p style={{ ...DAG_TOOLTIP_META, margin: 0, wordBreak: 'break-all' }}>{node.id}</p>
      {dagNodes.map((id) => (
        <p key={id} style={{ ...DAG_TOOLTIP_META, margin: 0 }}>
          {copy(AGENT_COPY_KEYS.dagNode, { id })}
        </p>
      ))}
      {node.metrics?.steps !== undefined && (
        <p style={{ ...DAG_TOOLTIP_META, margin: 0 }}>
          {copy('dag.steps', { steps: node.metrics.steps })}
        </p>
      )}
      {node.seenAt !== undefined && (
        <p style={{ ...DAG_TOOLTIP_META, margin: 0 }}>
          {copy('dag.measuredAt', { at: new Date(node.seenAt).toLocaleTimeString() })}
        </p>
      )}
    </div>
  );
}

export interface AgentTreeBodyProps {
  payload: MintAgentsPayload;
  copy: CopyTranslate;
  /** 这一次读数的宿主钟（信封的 `sampled_at`），与 `nowMs` 一起做走秒。 */
  sampledAtMs: number | undefined;
  nowMs: number;
  hovered: string | undefined;
  onHover: (id: string | undefined) => void;
  /** 该 agent 被哪些 DAG 节点认领过；由容器从第一视图的文档里查出来传进来。 */
  dagNodesOf: (agentId: string) => readonly string[];
}

/**
 * 视图本体：空树给空态，其余按 `layoutAgentTree` 画行。
 *
 * 整行的所有元素共用一个 `onMouseEnter`/`onMouseLeave` 组：盒子、标签、数字都算这一行，指针在
 * 它们之间移动不该让卡片闪。
 */
export function AgentTreeBody({
  payload,
  copy,
  sampledAtMs,
  nowMs,
  hovered,
  onHover,
  dagNodesOf,
}: AgentTreeBodyProps): ReactElement {
  if (payload.nodes.length === 0) {
    return (
      <div style={DAG_CANVAS}>
        <p style={{ ...NOTE, padding: '8px 10px', margin: 0 }}>{copy(AGENT_COPY_KEYS.empty)}</p>
      </div>
    );
  }

  const layout = layoutAgentTree(payload, copy, sampledAtMs, nowMs);
  const hoveredBox = layout.rows.find((box) => box.row.node.id === hovered);

  return (
    <div style={DAG_CANVAS}>
      <svg
        width={layout.width}
        height={layout.height}
        viewBox={`0 0 ${String(layout.width)} ${String(layout.height)}`}
        role="img"
        aria-label={copy(AGENT_COPY_KEYS.tabLabel)}
      >
        {layout.rows.map((box) => {
          const node = box.row.node;
          return (
            <g
              key={node.id}
              tabIndex={0}
              role="button"
              aria-label={node.label}
              onMouseEnter={() => {
                onHover(node.id);
              }}
              onMouseLeave={() => {
                onHover(undefined);
              }}
              onFocus={() => {
                onHover(node.id);
              }}
              onBlur={() => {
                onHover(undefined);
              }}
            >
              {box.row.parentLeft !== undefined && (
                <polyline
                  points={[
                    `${String(box.row.parentLeft + ELBOW_INSET)},${String(box.top - AGENT_ROW_GAP)}`,
                    `${String(box.row.parentLeft + ELBOW_INSET)},${String(box.top + AGENT_ROW_H / 2)}`,
                    `${String(box.labelX - ELBOW_INSET)},${String(box.top + AGENT_ROW_H / 2)}`,
                  ].join(' ')}
                  style={AGENT_ELBOW}
                />
              )}
              <rect
                x={box.row.left}
                y={box.top}
                width={layout.width - box.row.left - 12}
                height={AGENT_ROW_H}
                rx={6}
                style={agentRowStyle(agentTone(node))}
                className={isAgentRunning(node) ? DAG_RUNNING_CLASS : undefined}
              />
              <text
                x={box.labelX}
                y={box.top + AGENT_ROW_H / 2}
                dominantBaseline="middle"
                style={AGENT_ROW_LABEL}
              >
                {node.label}
              </text>
              <MetricsCells box={box} />
            </g>
          );
        })}
      </svg>
      {hoveredBox !== undefined && (
        <AgentCard
          box={hoveredBox}
          copy={copy}
          layout={layout}
          dagNodes={dagNodesOf(hoveredBox.row.node.id)}
        />
      )}
    </div>
  );
}
