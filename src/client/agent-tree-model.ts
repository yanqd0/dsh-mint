/**
 * 子代理树视图的纯逻辑：行、状态色、以及一行里到底写什么（规格见 `notes/agent-tree.md`）。
 *
 * 与 `DagBody.tsx` 分开的理由和 `dag-model.ts` 一样：`.tsx` 不进覆盖口径，而这里的每一支
 * （缺读数、main 不发 token、坏字段、断链的 parent）都是要能验的分支。
 *
 * 本模块只做**呈现**：它不判断谁在跑（那是宿主 `AgentNodeView.running` 的事），也不补默认值
 * ——缺失就是缺失，行上少一项好过写一个猜出来的 0。
 */
import type { AgentNodeView, DagNodeMetrics, MintAgentsPayload } from '../shared/records.js';
import type { CopyTranslate } from './copy.js';
import { formatCount } from './dag-model.js';
import type { StatusTone } from './model.js';

/** 行色调：running 绿（在跑），其余中性——agent 没有 verdict，故不借用 error/warn 两色。 */
export type AgentTone = 'success' | 'idle';

/** 行高与行距：与 DAG 节点同高，树因此读起来像同一套盒子排下来。 */
export const AGENT_ROW_H = 44;
export const AGENT_ROW_GAP = 8;

/** 每层缩进；肘线就画在这段空隙里。 */
export const AGENT_ROW_INDENT = 18;

/** 画布留白，同时也是最小画布（与 DAG 的 `DAG_PAD` 同一个理由）。 */
export const AGENT_PAD = 12;

/** 行内标签的最大列宽（缩进之外）。
 *
 * 子代理的 label 是派发时的 description，比 DAG 的六字标签长得多，故这里给一整列；
 * 超出部分由 `AgentTreeBody` 省略，完整文本走 hover 卡片。
 */
export const AGENT_LABEL_MAX = 220;

/** 计数的单位：`t` 与 `s` 都是行的分隔符里不出现的短记号。 */
const CONTEXT_UNIT = 't';
const TOKENS_UNIT = 't';

/** running 行还没测到耗时的占位。它不是文案（两侧同形），故与 DAG 的 `?` 一样是常量。 */
const TIME_PENDING = '?';

/** 已结束且什么都没测到的占位（与 `?` 刻意不同：不会再有数了）。 */
const TIME_NONE = '-';

/** 一行：一个节点的引用、它在树里的层号，以及与父行相连时肘线要画的坐标。 */
export interface AgentRow {
  node: AgentNodeView;
  /** 层号（宿主给的 `depth`）用于缩进，不用于任何判断。 */
  depth: number;
  /** 父行在画布里的左边界；根行（或断链退回根的行）没有。 */
  parentLeft: number | undefined;
  /** 本行在画布里的左边界。 */
  left: number;
}

/**
 * 行色调：running 是成功色（在跑），已结束/空闲是中性色。
 *
 * 这里刻意不用 warn/error：agent 树没有「谁对谁错」这种判断，黄/红会把一两行恰好停下的
 * 子代理读成告警。
 */
export function agentTone(node: AgentNodeView): AgentTone {
  return node.running ? 'success' : 'idle';
}

/** 行内状态徽标的色调：与 {@link agentTone} 同轴（徽标说的就是「在不在跑」）。 */
export function agentStatusTone(node: AgentNodeView): StatusTone {
  if (node.running) return 'success';
  return 'idle';
}

/** 该行是否该挂 running 脉动 class（与 DAG 的 running 节点**同一个** class）。 */
export function isAgentRunning(node: AgentNodeView): boolean {
  return node.running;
}

/**
 * 白名单式收下一个节点的实测：**只收这里点名的字段**，坏的一个数只丢它自己。
 *
 * 与 `dag-model.keepMetrics` 同一套判据（非负安全整数），只是这里不收 `at`——agent 树的读数
 * 不落盘，面板上永远都是「刚测的」，没有存量样本要标日期。
 */
export function agentMetrics(node: AgentNodeView): DagNodeMetrics | undefined {
  const raw = node.metrics;
  if (raw === undefined) return undefined;
  const kept: DagNodeMetrics = {};
  for (const field of ['tokens', 'context', 'steps', 'elapsed_ms'] as const) {
    const value = raw[field];
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) kept[field] = value;
  }
  return Object.keys(kept).length === 0 ? undefined : kept;
}

/**
 * 该行这一刻的耗时（毫秒）。
 *
 * 与 DAG 的 `measuredTimeMs` 刻意不同：agent 树的读数不落盘，所以没有「上一轮的存量样本」
 * 这回事——有数就是刚测的，可以直接按浏览器时钟继续走秒；宿主没给采样钟时就信它是当前值。
 */
export function agentElapsedMs(
  node: AgentNodeView,
  metrics: DagNodeMetrics | undefined,
  sampledAtMs: number | undefined,
  nowMs: number
): number | undefined {
  const elapsed = metrics?.elapsed_ms;
  if (elapsed === undefined) return undefined;
  if (!node.running || sampledAtMs === undefined) return elapsed;
  return elapsed + Math.max(0, nowMs - sampledAtMs);
}

/** 原始计数的展示形态：千位分隔、**不缩放**——这一层要能直接读出准确数字。 */
export function rawCount(value: number): string {
  return value.toLocaleString('en-US');
}

/** 一行的文本格（标签之外的那几段；缺失即 `undefined`，调用方不画它）。 */
export interface AgentRowCells {
  label: string;
  context: string | undefined;
  tokens: string | undefined;
  elapsed: string;
}

/**
 * 把一行折成待渲染的几格。
 *
 * **main 不发 tokens**：整条主会话的累计不是「这个节点花了多少」（宿主侧 `nodeMetrics` 的
 * `kind === 'main'` 已经不发；这里再守一道，缺字段即不画）。
 *
 * 耗时的占位分两种：running 且还没测到写 `?`（会有数），其余写 `-`（不会有了）。缺读数与
 * 「读数恰好是 0」在面板上必须能分开。
 */
export function agentRowCells(
  node: AgentNodeView,
  metrics: DagNodeMetrics | undefined,
  sampledAtMs: number | undefined,
  nowMs: number,
  copy: CopyTranslate
): AgentRowCells {
  const elapsedMs = agentElapsedMs(node, metrics, sampledAtMs, nowMs);
  const elapsed =
    elapsedMs === undefined
      ? node.running
        ? TIME_PENDING
        : TIME_NONE
      : `${rawCount(Math.floor(elapsedMs / 1000))}${copy('dag.seconds')}`;
  return {
    label: node.label,
    context:
      metrics?.context === undefined ? undefined : `${rawCount(metrics.context)}${CONTEXT_UNIT}`,
    tokens:
      node.kind === 'main' || metrics?.tokens === undefined
        ? undefined
        : `${formatCount(metrics.tokens)}${TOKENS_UNIT}`,
    elapsed,
  };
}

/**
 * 把扁平节点数组排成**先序行**，缩进由 `depth` 决定。
 *
 * 宿主已经给了先序与深度，这里只做两件必需的事：
 *
 * 1. **父缺失就退回根**（坏数据、或被丢掉的中间层）：行仍然画出来，绝不因为一条断掉的
 *    `parent` 让整支消失。
 * 2. **重复 id 与环**：每个 id 至多一行；第二次出现退回根。
 */
export function agentRows(nodes: readonly AgentNodeView[]): AgentRow[] {
  const known = new Set(nodes.map((node) => node.id));
  const left = new Map<string, number>();
  const rows: AgentRow[] = [];
  for (const node of nodes) {
    if (left.has(node.id)) continue;
    const ownLeft = agentRowLeft(node.depth);
    left.set(node.id, ownLeft);
    const parent = node.parent;
    const attached = parent !== undefined && known.has(parent) && left.has(parent);
    rows.push({
      node,
      depth: node.depth,
      parentLeft: attached && parent !== undefined ? left.get(parent) : undefined,
      left: ownLeft,
    });
  }
  return rows;
}

/** 一行在画布里的横向位置：留白 + 层号 × 缩进。 */
export function agentRowLeft(depth: number): number {
  return AGENT_PAD + depth * AGENT_ROW_INDENT;
}

/** 整张画布的高度：行数 × 行高 + 行距 + 上下留白。 */
export function agentCanvasHeight(rowCount: number): number {
  if (rowCount === 0) return AGENT_PAD * 2;
  return AGENT_PAD * 2 + rowCount * AGENT_ROW_H + (rowCount - 1) * AGENT_ROW_GAP;
}

/** 画布的最小宽度：标签列 + 数字列留出的余量（外层视口不够时横向滚动）。 */
export function agentCanvasWidth(labelWidth: number): number {
  return Math.max(260, AGENT_PAD * 2 + labelWidth);
}

/** 数字列与标签列之间的固定间隙。 */
export const AGENT_LABEL_METRICS_GAP = 16;

/** 每个字符按这个宽度估算标签列宽（中英混排的近似值，只用于决定画布宽度）。 */
const CHAR_WIDTH = 7.2;

/** 数字列预留的宽度：`888,888t · 888,888t · 888s`。 */
export const AGENT_METRICS_COLUMN_W = 156;

/** 行左侧与标签之间的内边距。 */
export const AGENT_ROW_PAD = 8;

/** 该行的标签要占多宽（按字符数估算，封顶 {@link AGENT_LABEL_MAX}）。 */
export function agentLabelWidth(label: string): number {
  return Math.min(AGENT_LABEL_MAX, label.length * CHAR_WIDTH);
}

/** 一行的排版结果：画布坐标、两列的位置，以及那一行要写的文本。 */
export interface AgentRowBox {
  row: AgentRow;
  cells: AgentRowCells;
  top: number;
  /** 标签文本的起点。 */
  labelX: number;
  /** 数字段的右端（右对齐）。 */
  metricsRight: number;
}

export interface AgentTreeLayout {
  width: number;
  height: number;
  rows: AgentRowBox[];
  /** 每个节点 id 的行顶（悬停卡片定位用）。 */
  topOf: Record<string, number>;
}

/**
 * 排版：先算标签列需要多宽，再把每行摆到它的 `depth` 缩进上、数字列贴住右端。
 *
 * 纯函数、不读 DOM：画布尺寸与每格文本因此可以在 Node 里验证，`AgentTreeBody` 只负责画。
 */
export function layoutAgentTree(
  payload: MintAgentsPayload,
  copy: CopyTranslate,
  sampledAtMs: number | undefined,
  nowMs: number
): AgentTreeLayout {
  const rows = agentRows(payload.nodes);
  const labelWidth = rows.reduce(
    (widest, row) => Math.max(widest, agentLabelWidth(row.node.label)),
    0
  );
  const widestRow = rows.reduce((widest, row) => Math.max(widest, row.left + AGENT_ROW_PAD), 0);
  const width = Math.max(
    260,
    widestRow + labelWidth + AGENT_LABEL_METRICS_GAP + AGENT_METRICS_COLUMN_W
  );
  const metricsRight = width - 12;
  const boxes: AgentRowBox[] = [];
  const topOf: Record<string, number> = {};
  rows.forEach((row, index) => {
    const top = AGENT_PAD + index * (AGENT_ROW_H + AGENT_ROW_GAP);
    topOf[row.node.id] = top;
    boxes.push({
      row,
      cells: agentRowCells(row.node, agentMetrics(row.node), sampledAtMs, nowMs, copy),
      top,
      labelX: row.left + AGENT_ROW_PAD,
      metricsRight,
    });
  });
  return { width, height: agentCanvasHeight(boxes.length), rows: boxes, topOf };
}

/**
 * 这一视图的 copy key 集中命名处。
 *
 * 与 `DAG_COPY_KEYS` 同一个理由：`.tsx` 组件不进覆盖口径，而 copy 守卫按源码字面量判「有
 * 没有人用这个键」，所以这些键必须在这份源码里出现。
 */
export const AGENT_COPY_KEYS = {
  tabNodes: 'agents.tab.nodes',
  tabSubagents: 'agents.tab.subagents',
  tabLabel: 'agents.tab.label',
  empty: 'agents.empty',
  count: 'agents.count',
  running: 'agents.running',
  unsupported: 'agents.unsupported',
  dagNode: 'agents.dagNode',
  root: 'agents.root',
  seconds: 'dag.seconds',
} as const;

/**
 * 面板摘要行：`3 个节点 · 2 个在跑 · 1 个未支持`。
 *
 * 只列真的非零的附加项：0 个在跑的图不必多一截「0 个在跑」，而未支持条目的计数是**必须**
 * 出现的——它解释「为什么树上有东西没画出来」。
 */
export function agentSummary(payload: MintAgentsPayload, copy: CopyTranslate): string {
  const parts = [copy(AGENT_COPY_KEYS.count, { count: payload.counts.total })];
  if (payload.counts.running > 0) {
    parts.push(copy(AGENT_COPY_KEYS.running, { count: payload.counts.running }));
  }
  if (payload.counts.unsupported > 0) {
    parts.push(copy(AGENT_COPY_KEYS.unsupported, { count: payload.counts.unsupported }));
  }
  return parts.join(' · ');
}
