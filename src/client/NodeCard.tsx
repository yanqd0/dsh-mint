/**
 * 节点盒子与悬停卡片：SVG 内画第二行测量值，hover 卡片给出全量字段。卡片是 DOM 而非 SVG
 * （同一套配色走 `color` 而非 `fill`）；工作树字段直接来自路由信封，组件不碰 git 或文件系统。
 */
import type { CSSProperties, ReactElement } from 'react';

import type { DagNodeMetrics, DagNodeView } from '../shared/records.js';
import {
  DAG_COPY_KEYS,
  dagStatusTone,
  dagWorktreeTone,
  formatCount,
  formatSeconds,
} from './dag-model.js';
import type { layoutDag } from './dag-model.js';
import {
  LIVE_TIME_COLOR,
  LIVE_TOKENS_COLOR,
  DAG_NODE_METRICS,
  DAG_TOOLTIP,
  DAG_TOOLTIP_META,
  dagLiveTimeStyle,
  dagLiveTokensStyle,
  pill,
} from './styles.js';
import type { MintBodyProps } from './types.js';
import { measuredAtLabel, measuredTimeMs } from './dag-sampler.js';
import { phaseLabel, statusLabel, verdictLabel, worktreeStateLabel } from './dag-labels.js';

/** The token unit inside a node box: the box is 104 wide and the label 12px. */
const TOKEN_UNIT = 't';

const METRICS_SEPARATOR = ' · ';

/** A running node whose sample has not arrived: a time is coming, none is known. */
const TIME_PENDING = '?';

/** A settled node with nothing measured: there is nothing left to wait for. */
const TIME_NONE = '-';

/** Units and separators: legible, but never in a measured number's own color. */
const METRICS_SECONDARY: CSSProperties = {
  fill: 'var(--dsw-alias-label-secondary)',
};

/** The full title is the tooltip's headline; it wraps instead of clipping. */
const TOOLTIP_TITLE: CSSProperties = {
  margin: '0 0 4px',
  fontWeight: 500,
};

const TOOLTIP_LINE: CSSProperties = {
  margin: 0,
};

const TOOLTIP_BADGES: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  flexWrap: 'wrap',
  margin: '0 0 4px',
};

const TOOLTIP_QUIET: CSSProperties = {
  color: 'var(--dsw-alias-label-secondary)',
};

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
 * 节点盒子里的第二行：宿主测到的数字，用盒子自己的颜色——每个数字保留自己的填充色（token 琥珀、
 * 时间紫），单位与分隔符走次级标签色，这样这一行读起来是「两个数」而不是一句话；token 单位只写一个
 * `t`，因为盒子宽 104、写全 `tokens` 就占满。
 *
 * `pending` 节点还没有 agent、无可测量，整行不画。`running` 节点在时间位画 `?`，直到*实时*样本到达
 * （存量样本带日期、不算 running，同样显示 `?`）；已结束节点什么都没有画 `-`，只有 token 就只画 token。
 */
export function NodeMetricsLine({
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

interface NodeTooltipProps {
  node: DagNodeView;
  copy: MintBodyProps['copy'];
  layout: ReturnType<typeof layoutDag>;
  metrics: DagNodeMetrics | undefined;
  sampledAtMs: number | undefined;
  nowMs: number;
}

/**
 * hover 卡片：节点的完整文本，加上读者否则得去问工具的那些字段。
 *
 * status 与 verdict 放在 chip 行，因为页脚是那行安静的文字；测量数字沿用节点盒子给它们的颜色，
 * 卡片与盒子因此读起来是对同一节点的同一次读数。卡片是 DOM 不是 SVG，同一套配色走 `color`。
 *
 * 时间行也是*存量*读数标明日期的地方：旁边那个数字是子代理还活着时测的，卡片因此用本地时钟点出
 * 那一刻，免得读者把它当成现在。
 *
 * 节点独占的工作树是卡片的另一条 chip 行：状态按 status pill 上色，它工作的分支就在旁边。这里
 * 不碰 git 或文件系统——分支、状态与路径都是路由自己的字段。
 */
export function NodeTooltip({
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

interface LiveTokensLineProps {
  copy: MintBodyProps['copy'];
  tokens: number;
}

/**
 * 卡片里测到的 token 数，着色在它那句译文内部。词典的实时行是一整句、只把数量插进去
 * （`{tokens} tokens (measured)`），而只有数量能取测量的颜色——单位与来源说明保持次级；这一行
 * 因此围着被插进去的数字切开，这是精确的：两个 locale 的周边文本都不含数字。
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
