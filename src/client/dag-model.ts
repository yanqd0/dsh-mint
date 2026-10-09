/**
 * plan DAG 的绘制模型：状态配色、节点几何，以及面板渲染成 SVG 的分层布局
 * （规格见 `notes/plan-dag.md`）。
 *
 * 宿主不下发坐标——文档只是图，布局放在这里，让浏览器成为决定像素的唯一一处。
 * 全文件都是视图的纯函数：无需 DOM 即可在 Node 里验证几何，同一视图永远画出同一张图。
 */
import { dagLayers } from '../dag/dag.js';
import type { DagNodeMetrics, DagNodeView, DagView, DagWorktreeState } from '../shared/records.js';
import type { StatusTone } from './model.js';

/** 节点框：宽度容得下六码点标签；高度要放两行（标签 + 实测指标），故为 44。 */
export const DAG_NODE_W = 104;
export const DAG_NODE_H = 44;

/** 层内水平间隙；层间垂直间隙（连线的肘部走在其中）。 */
export const DAG_H_GAP = 16;
export const DAG_V_GAP = 46;

/** 画布留白，同时也是最小画布：空 DAG 也要有边框。 */
export const DAG_PAD = 12;

/**
 * 节点可取的三种主题状态色：status 与 verdict 在这里合成一轴——`done` 自身没有
 * 颜色，读者要看的是结果，而不是「这个节点停下了」。
 */
export type DagTone = 'warn' | 'success' | 'error';

export interface DagBox {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 一条边即一条 SVG `<polyline>`：`points` 是 `x,y x,y x,y` 串。 */
export interface DagEdgeLine {
  from: string;
  to: string;
  points: string;
}

export interface DagLayout {
  width: number;
  height: number;
  boxes: DagBox[];
  edges: DagEdgeLine[];
}

/**
 * 节点盒子的色调：`pending` 琥珀（等待）、`running` 绿（进行中），已结算的看 verdict。
 * `done` 而无 verdict 是宿主对半截文档的容忍，按成功画，不冤判成失败。
 */
export function dagTone(node: DagNodeView): DagTone {
  if (node.status === 'pending') return 'warn';
  if (node.status === 'running') return 'success';
  return node.verdict === 'fail' ? 'error' : 'success';
}

export function isRunning(node: DagNodeView): boolean {
  return node.status === 'running';
}

/**
 * 节点状态徽标（`pill()`）的色调：与 {@link dagTone} 是同一节点的两种刻意读法——
 * 徽标说的是节点*正在做什么*，故 `pending` 与 `running` 都用提醒色；只有被否决的
 * 节点两处都红。
 */
export function dagStatusTone(node: DagNodeView): StatusTone {
  if (node.status === 'pending' || node.status === 'running') return 'warn';
  return node.verdict === 'fail' ? 'error' : 'success';
}

/**
 * 节点 worktree 状态 chip 的色调：该状态说的是分支，不是节点自身的生命周期，故另作
 * 一轴——未合并是仍在外面的活（提醒色），冲突最不能漏（红），已进主线即已结算（绿）；
 * worktree 已不在只是工作区的事实，用中性 chip，而非它并不是的告警。
 */
export function dagWorktreeTone(state: DagWorktreeState): StatusTone {
  switch (state) {
    case 'active':
      return 'warn';
    case 'merged':
      return 'success';
    case 'conflict':
      return 'error';
    case 'removed':
      return 'idle';
  }
}

/**
 * 联合依赖图读成 `child → parents` 的边：`depends_on` 与 `edges` 是同一种关系的两种
 * 写法（`[from, to]` 表示 to 依赖 from），故同一对去重；引用未知 id 的边丢掉不画，
 * 遍历从 `view.nodes` 起步，顺序因此随文档而非 Map 的插入史。
 */
function parentEdges(view: DagView): Array<[string, string]> {
  const known = new Set(view.nodes.map((node) => node.id));
  const pairs: Array<[string, string]> = [];
  const seen = new Set<string>();
  const add = (from: string, to: string): void => {
    if (from === to || !known.has(from) || !known.has(to)) return;
    const key = `${from}\u0000${to}`;
    if (seen.has(key)) return;
    seen.add(key);
    pairs.push([from, to]);
  };
  for (const node of view.nodes) {
    for (const dependency of node.depends_on) add(dependency, node.id);
  }
  for (const [from, to] of view.edges) add(from, to);
  return pairs;
}

/** SVG 属性里的坐标：抹掉浮点噪声，绝不出现 `1e-7` 这种写法。 */
function round(value: number): string {
  return String(Number(value.toFixed(3)));
}

/**
 * 布局一张 DAG：分层自上而下，层内节点从左到右、整体居中。
 *
 * 分层复用宿主自己的 `dagLayers`，它容忍环与悬空引用而不抛错——手改坏的文件必须画出
 * 一张错的图，绝不能是空白面板。
 */
export function layoutDag(view: DagView): DagLayout {
  // dagLayers 的层号正好就是行号（层 0 是无依赖者，节点排在最深依赖之后）。
  const layers = dagLayers(view.nodes, view.edges);
  const depth = new Map<string, number>();
  layers.forEach((layer, level) => {
    for (const id of layer) depth.set(id, level);
  });

  // 分组随 `view.nodes` 顺序：万一分层漏掉某节点（今天不会，但两者的形状互不保证），
  // 它仍然会有盒子。
  const groups: string[][] = [];
  for (const node of view.nodes) {
    const level = depth.get(node.id) ?? 0;
    (groups[level] ??= []).push(node.id);
  }

  let width = 0;
  for (const group of groups) {
    if (group === undefined || group.length === 0) continue;
    width = Math.max(width, group.length * DAG_NODE_W + (group.length - 1) * DAG_H_GAP);
  }
  width = Math.max(width, DAG_NODE_W);

  const boxes: DagBox[] = [];
  const at = new Map<string, DagBox>();
  groups.forEach((group, level) => {
    if (group.length === 0) return;
    const rowWidth = group.length * DAG_NODE_W + (group.length - 1) * DAG_H_GAP;
    const left = DAG_PAD + (width - rowWidth) / 2;
    group.forEach((id, column) => {
      const box: DagBox = {
        id,
        x: left + column * (DAG_NODE_W + DAG_H_GAP),
        y: DAG_PAD + level * (DAG_NODE_H + DAG_V_GAP),
        w: DAG_NODE_W,
        h: DAG_NODE_H,
      };
      boxes.push(box);
      at.set(id, box);
    });
  });

  const edges: DagEdgeLine[] = [];
  for (const [from, to] of parentEdges(view)) {
    const parent = at.get(from);
    const child = at.get(to);
    if (parent === undefined || child === undefined) continue;
    // 三点折线：出父节点底边、在间隙中部横折、入子节点顶边。只有中段 y 需要挑，间隙
    // 也够宽，两段横线读起来像一个肘部。
    const x1 = parent.x + parent.w / 2;
    const y1 = parent.y + parent.h;
    const x2 = child.x + child.w / 2;
    const y2 = child.y;
    const midY = (y1 + y2) / 2;
    edges.push({
      from,
      to,
      points: `${round(x1)},${round(y1)} ${round(x2)},${round(midY)} ${round(x2)},${round(y2)}`,
    });
  }

  return {
    width: DAG_PAD * 2 + width,
    height: DAG_PAD * 2 + groups.length * DAG_NODE_H + Math.max(0, groups.length - 1) * DAG_V_GAP,
    boxes,
    edges,
  };
}

export function dagCounts(view: DagView): {
  nodes: number;
  edges: number;
  pending: number;
  running: number;
  done: number;
} {
  const counts = {
    nodes: view.nodes.length,
    edges: view.edges.length,
    pending: 0,
    running: 0,
    done: 0,
  };
  for (const node of view.nodes) counts[node.status] += 1;
  return counts;
}

/**
 * 节点实测行所用 copy key 的集中命名处：唯一调用方 `DagBody` 是 `.tsx`，本模块无法
 * import；面板的 copy 守卫又只读源码文本——字典里有、源码里却无人引用的 key 会被判成
 * 死键，故这些 key 必须在这份源码里出现。
 */
export const DAG_COPY_KEYS = {
  liveTokens: 'dag.liveTokens',
  seconds: 'dag.seconds',
  measuredAt: 'dag.measuredAt',
} as const;

function measuredInt(value: unknown): number | undefined {
  // 宿主发的是一对数，但路由过的是 JSON：负数、小数、非数都是该丢的 bug，而不是
  // 一个该画出来的数。
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/**
 * 逐字段收下一个节点的实测：坏的 `tokens` 不该连累好的 `elapsed_ms`。
 *
 * `at` 有独立含义——只有**已落库**的采样带它，故它区分「这是上一轮的读数」与「宿主此刻
 * 正在测」；缺失即现场，保持缺失；一旦出现就必须是可用的时间戳：坏时间宁可整条丢掉，
 * 也不能改标成一次从未发生的测量。
 */
function keepMetrics(raw: unknown): DagNodeMetrics | undefined {
  const entry = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const tokens = measuredInt(entry['tokens']);
  const elapsedMs = measuredInt(entry['elapsed_ms']);
  const kept: DagNodeMetrics = {};
  if (tokens !== undefined) kept.tokens = tokens;
  if (elapsedMs !== undefined) kept.elapsed_ms = elapsedMs;
  if (entry['at'] !== undefined) {
    const at = measuredInt(entry['at']);
    if (at === undefined) return undefined;
    kept.at = at;
  }
  if (kept.tokens === undefined && kept.elapsed_ms === undefined) return undefined;
  return kept;
}

/**
 * 宿主的分节点实测，过滤到可以画的部分：路由可能带着本文档已经没有的节点，半截采样也
 * 可能好字段旁躺着坏字段，两种都按规则丢掉，让节点显示真值而非它被写成什么。没有文档、
 * 答案不带 metrics、或无一存活时一律给空表——绝不用 0 去猜。
 */
export function nodeMetricsMap(payload: {
  metrics?: Record<string, DagNodeMetrics>;
  dag: DagView | null;
}): Record<string, DagNodeMetrics> {
  const { dag, metrics } = payload;
  if (dag === null || metrics === undefined) return {};
  const known = new Set(dag.nodes.map((node) => node.id));
  const kept: Record<string, DagNodeMetrics> = {};
  for (const [id, raw] of Object.entries(metrics)) {
    if (!known.has(id)) continue;
    const entry = keepMetrics(raw);
    if (entry === undefined) continue;
    kept[id] = entry;
  }
  return kept;
}

function scaled(value: number): string {
  // `String` 会抹掉末尾的 `.0`，所以整千读作 `1k` 而不是 `1.0k`。
  return String(value >= 100 ? Math.round(value) : Math.round(value * 10) / 10);
}

/**
 * 令牌数的一行短标签：`999` / `1.2k` / `123k` / `1.5M`——千以下精确，以上缩放取整，
 * 缩放值到百位后不再留小数：那一位读者用不上，盒子里也没有那一列。
 */
export function formatCount(tokens: number): string {
  if (tokens < 1e3) return String(tokens);
  if (tokens < 1e6) return `${scaled(tokens / 1e3)}k`;
  return `${scaled(tokens / 1e6)}M`;
}

/**
 * 耗时一律读成秒：节点是一次子代理运行，分秒写法只会占列而不会增信息。一分钟内截断为
 * 整秒（`3200` → `3`），此后留一位小数（`75400` → `75.4`）。截断是刻意的——这一行不
 * 得声称一个尚未走完的秒。负值是时钟偏移，读作 0。
 */
export function formatSeconds(ms: number): string {
  if (ms <= 0) return '0';
  if (ms < 60000) return String(Math.floor(ms / 1000));
  return String(Math.floor(ms / 100) / 10);
}

/**
 * running 节点此刻该显示的耗时：宿主只在应答时采样 `elapsed_ms`，两次应答之间的实时值
 * 就是「那次采样 + 此后经过的时间」，所以既需要宿主锚点时钟（`sampled_at`），也需要浏览
 * 器的 `now`。两个时钟不必一致：负的间隔是偏移而非时光倒流，按 0 计；宿主没给锚点时
 * 就信它是当前值。
 */
export function liveElapsedMs(
  elapsedMs: number | undefined,
  sampledAtMs: number | undefined,
  nowMs: number
): number | undefined {
  if (elapsedMs === undefined) return undefined;
  if (sampledAtMs === undefined) return elapsedMs;
  return elapsedMs + Math.max(0, nowMs - sampledAtMs);
}
