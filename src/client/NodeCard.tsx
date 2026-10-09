/**
 * 节点盒子与悬停卡片：SVG 内的第二行测量值、以及 hover 时读到的全量字段。
 *
 * 卡片是 DOM 而非 SVG：同一套配色改用 `color` 而不是 `fill`；节点自身的工作树
 * 字段直接来自路由信封，组件不碰 git 或文件系统。
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
 * 每个数字保留自己的填充色（token 琥珀、时间紫），单位与分隔符用次级标签色，
 * 这样这一行读起来是「两个数」而不是一句话。token 单位只写一个 `t`：盒子宽 104，
 * 写全 `tokens` 就占满了。
 *
 * A `pending` node has no agent yet and therefore nothing to measure, so it
 * draws no line at all. A running node draws `?` in the time slot until a *live*
 * sample arrives (a time is coming, none is known) — a stored one is dated, not
 * running, so it shows the same `?`; a settled node with nothing in it draws `-`
 * (there is nothing left to wait for), and a settled node that only ever
 * reported tokens draws just those.
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
