/**
 * plan DAG 的绘制模型：状态配色、节点几何，以及面板渲染成 SVG 的分层布局
 * （规格见 `notes/plan-dag.md`）。
 *
 * 宿主不下发坐标——文档只是图，布局放在这里，让浏览器成为决定像素的唯一一处。
 * 全文件都是视图的纯函数：无需 DOM 即可在 Node 里验证几何，同一视图永远画出同一张图。
 */
import { DAG_PHASES, dagLayers } from '../dag/dag.js';
import type { DagNodeMetrics, DagNodeView, DagView, DagWorktreeState } from '../shared/records.js';
import type { CopyKey, CopyTranslate } from './copy.js';
import type { StatusTone } from './model.js';

/** 节点框：宽度容得下六码点标签；高度要放两行（标签 + 实测指标），故为 44。 */
export const DAG_NODE_W = 104;
export const DAG_NODE_H = 44;

/** 层内水平间隙；层间垂直间隙（连线的肘部走在其中）。 */
export const DAG_H_GAP = 16;
export const DAG_V_GAP = 46;

/** 画布留白，同时也是最小画布：空 DAG 也要有边框。 */
export const DAG_PAD = 12;

/** 阶段带的标签条高度：带名写在条内，节点因此从条下起排。 */
export const DAG_STAGE_HEAD = 18;

/** 阶段带的左右与底部留白：节点不贴框，带与内容之间留出呼吸。 */
export const DAG_STAGE_PAD = 10;

/** 相邻阶段带间隙（竖排纵向 / 横排横向）。 */
export const DAG_STAGE_GAP = 20;

/** 图层推进的方向（横排 = 整张图转 90°）：默认自上而下。 */
export type DagDirection = 'vertical' | 'horizontal';

export const DAG_DIRECTIONS = ['vertical', 'horizontal'] as const satisfies readonly DagDirection[];

/** 路由过界的方向是 JSON，故按谓词收窄而不是 `as`。 */
export function isDagDirection(value: unknown): value is DagDirection {
  return (DAG_DIRECTIONS as readonly string[]).includes(value as string);
}

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

/** 一个阶段的带：包住该阶段全部节点的框，`phase` 是阶段名（未知阶段原样保留）。 */
export interface DagStageBand {
  phase: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** 带内节点数（标签上显示）。 */
  count: number;
}

export interface DagLayout {
  width: number;
  height: number;
  boxes: DagBox[];
  edges: DagEdgeLine[];
  bands: DagStageBand[];
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

/** 层内 n 个盒子并排的宽度：n 个盒宽加 n-1 个水平间隙。 */
function rowWidth(count: number): number {
  return count * DAG_NODE_W + Math.max(0, count - 1) * DAG_H_GAP;
}

/** 层内 n 个盒子纵向叠放的高度：n 个盒高加 n-1 个垂直间隙。 */
function columnHeight(count: number): number {
  return count * DAG_NODE_H + Math.max(0, count - 1) * DAG_V_GAP;
}

/**
 * 按阶段把节点分组：已知阶段按 {@link DAG_PHASES} 的顺序各占一组（空组丢掉），
 * 枚举外的阶段（手改坏的文件）按首次出现顺序另起一组，排在已知阶段之后。
 *
 * 用 Map 的插入序承载这个顺序：先按阶段顺序种下已知阶段，再在遍历文档时追加未知阶段。
 */
function stageGroups(view: DagView): Array<{ phase: string; nodes: DagNodeView[] }> {
  const buckets = new Map<string, DagNodeView[]>();
  for (const phase of DAG_PHASES) buckets.set(phase, []);
  for (const node of view.nodes) {
    const phase: string = node.phase;
    const bucket = buckets.get(phase);
    if (bucket === undefined) {
      buckets.set(phase, [node]);
      continue;
    }
    bucket.push(node);
  }
  const groups: Array<{ phase: string; nodes: DagNodeView[] }> = [];
  for (const [phase, nodes] of buckets) {
    if (nodes.length === 0) continue;
    groups.push({ phase, nodes });
  }
  return groups;
}

/**
 * 布局一张 DAG：**先按阶段分区、带内再按依赖分层**。默认带自上而下；横排 = 整张图转 90°
 * （带左右并排、公共带高、层号→列、层内节点纵向排列并居中）。
 *
 * 竖排：阶段带按计划 → 执行 → 收尾从上往下排，带内分层逐层向下、层内节点从左到右并整体居中。
 * 横排：阶段带沿 x 从前往后排，带宽只由本带内容决定，带高取各带内容的极值（公共带高，故各带同高），
 * 带内分层逐层向右、层内节点自上而下并在公共带高里居中，连线从父节点右中走到子节点左中。
 *
 * 分层复用宿主自己的 `dagLayers`，它容忍环与悬空引用而不抛错——手改坏的文件必须画出一张错的
 * 图，绝不能是空白面板。分层在**每一带内部**做，故不同阶段的节点绝不共行共列；跨阶段的边照画
 * （两个盒子都在），只是不参与任何一带的分层。
 */
export function layoutDag(view: DagView, direction: DagDirection = 'vertical'): DagLayout {
  const groups = stageGroups(view);

  // 每带先算自己的层号与内容尺寸：带内节点数目决定带有多宽、多高，画幅再取各带的极值。
  const laid = groups.map((group) => {
    const layers = dagLayers(group.nodes, view.edges);
    // 层的下标就是行号（竖排）或列号（横排），空洞（成环时的空层）按 0 计但不画。
    const counts: number[] = [];
    for (let level = 0; level < layers.length; level += 1) counts.push(layers[level]?.length ?? 0);
    const contentW =
      direction === 'horizontal'
        ? rowWidth(counts.length)
        : Math.max(0, ...counts.map((count) => rowWidth(count)));
    const contentH =
      direction === 'horizontal'
        ? Math.max(0, ...counts.map((count) => columnHeight(count)))
        : columnHeight(counts.length);
    return { group, layers, contentW, contentH };
  });

  const maxContentW = Math.max(0, ...laid.map((stage) => stage.contentW));
  // 竖排各带同宽（取内容极值 + 两侧留白，至少容得下一个盒子）；横排各带同高（公共带高）。
  const innerW = Math.max(DAG_NODE_W, maxContentW + 2 * DAG_STAGE_PAD);
  const innerH = Math.max(DAG_NODE_H, Math.max(0, ...laid.map((stage) => stage.contentH)));
  const bandH = DAG_STAGE_HEAD + innerH + DAG_STAGE_PAD;

  const boxes: DagBox[] = [];
  const at = new Map<string, DagBox>();
  const bands: DagStageBand[] = [];
  // `cursor` 是竖排的带顶 / 横排的带左；`span` 累计竖排总高、横排总宽。
  let cursor = DAG_PAD;
  let span = 0;

  for (const { group, layers, contentW, contentH } of laid) {
    const band: DagStageBand = {
      phase: group.phase,
      x: direction === 'horizontal' ? cursor : DAG_PAD,
      y: direction === 'horizontal' ? DAG_PAD : cursor,
      w: direction === 'horizontal' ? contentW + 2 * DAG_STAGE_PAD : innerW,
      h: direction === 'horizontal' ? bandH : DAG_STAGE_HEAD + contentH + DAG_STAGE_PAD,
      count: group.nodes.length,
    };
    bands.push(band);
    cursor += (direction === 'horizontal' ? band.w : band.h) + DAG_STAGE_GAP;
    span += direction === 'horizontal' ? band.w : band.h;

    // 内容在带内居中：竖排按带宽收窄左右留白，横排按公共带高上下居中。
    const left =
      direction === 'horizontal'
        ? band.x + DAG_STAGE_PAD
        : band.x + DAG_STAGE_PAD + (band.w - 2 * DAG_STAGE_PAD - contentW) / 2;

    for (let level = 0; level < layers.length; level += 1) {
      const layer = layers[level];
      if (layer === undefined || layer.length === 0) continue;
      // 横排里单节点列因此垂直居中于公共带高，与竖排里单节点行水平居中对齐。
      const top =
        direction === 'horizontal'
          ? band.y + DAG_STAGE_HEAD + (innerH - columnHeight(layer.length)) / 2
          : band.y + DAG_STAGE_HEAD;
      layer.forEach((id, column) => {
        const box: DagBox = {
          id,
          x:
            direction === 'horizontal'
              ? left + level * (DAG_NODE_W + DAG_H_GAP)
              : left + column * (DAG_NODE_W + DAG_H_GAP),
          y:
            direction === 'horizontal'
              ? top + column * (DAG_NODE_H + DAG_V_GAP)
              : top + level * (DAG_NODE_H + DAG_V_GAP),
          w: DAG_NODE_W,
          h: DAG_NODE_H,
        };
        boxes.push(box);
        at.set(id, box);
      });
    }
  }

  // 空文档不带：竖排退成一条最小带宽、横排退成零高，两者都靠 DAG_PAD 撑出最小画幅。
  span += DAG_STAGE_GAP * Math.max(0, laid.length - 1);
  const frameW = laid.length === 0 ? DAG_NODE_W : direction === 'horizontal' ? span : innerW;
  const frameH = laid.length === 0 ? 0 : direction === 'horizontal' ? bandH : span;

  const edges: DagEdgeLine[] = [];
  for (const [from, to] of parentEdges(view)) {
    const parent = at.get(from);
    const child = at.get(to);
    if (parent === undefined || child === undefined) continue;
    // 三点折线：竖排出父底边、横排出父右边，都在间隙中部折一次再进子节点。
    if (direction === 'horizontal') {
      const x1 = parent.x + parent.w;
      const y1 = parent.y + parent.h / 2;
      const x2 = child.x;
      const y2 = child.y + child.h / 2;
      const midX = (x1 + x2) / 2;
      edges.push({
        from,
        to,
        points: `${round(x1)},${round(y1)} ${round(midX)},${round(y1)} ${round(midX)},${round(y2)} ${round(x2)},${round(y2)}`,
      });
      continue;
    }
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
    width: DAG_PAD * 2 + frameW,
    height: DAG_PAD * 2 + frameH,
    boxes,
    edges,
    bands,
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
 * 节点实测行所用 copy key 的集中命名处：调用方是 `.tsx`（NodeCard），本模块无法
 * import；面板的 copy 守卫又只读源码文本——字典里有、源码里却无人引用的 key 会被判成
 * 死键，故这些 key 必须在这份源码里出现。
 */
export const DAG_COPY_KEYS = {
  liveTokens: 'dag.liveTokens',
  seconds: 'dag.seconds',
  measuredAt: 'dag.measuredAt',
  bucketUncached: 'dag.bucket.uncachedInput',
  bucketCacheRead: 'dag.bucket.cacheRead',
  bucketCacheWrite: 'dag.bucket.cacheWrite',
  bucketOutput: 'dag.bucket.output',
  steps: 'dag.steps',
  dirLabel: 'dag.dir.label',
  dirVertical: 'dag.dir.vertical',
  dirHorizontal: 'dag.dir.horizontal',
  stagePlan: 'dag.stage.plan',
  stageExec: 'dag.stage.exec',
  stagePost: 'dag.stage.post',
} as const;

/** 阶段带标签所用的三阶段文案；枚举外的阶段不在表内，标签原样显示它。 */
const STAGE_COPY: Record<string, CopyKey> = {
  research: DAG_COPY_KEYS.stagePlan,
  exec: DAG_COPY_KEYS.stageExec,
  post: DAG_COPY_KEYS.stagePost,
};

/**
 * 阶段带的标签：已知三阶段取本地化文案，枚举外的阶段（手改坏的文件）原样报出该字符串——
 * 冒充某个已知阶段会让读者看错分区。
 */
export function stageLabel(copy: CopyTranslate, phase: string): string {
  const key = STAGE_COPY[phase];
  return key === undefined ? phase : copy(key);
}

/** 阶段带的表头：`阶段名 · 节点数`。 */
export function stageHeadline(copy: CopyTranslate, phase: string, count: number): string {
  return `${stageLabel(copy, phase)} · ${String(count)}`;
}

function measuredInt(value: unknown): number | undefined {
  // 宿主发的是一对数，但路由过的是 JSON：负数、小数、非数都是该丢的 bug，而不是
  // 一个该画出来的数。
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/**
 * 逐字段收下一个节点的实测：坏的一个数不该连累好的四桶与时长。
 *
 * 白名单式：**只收这里点名的字段**，新增字段漏一处就静默丢掉——这正是本函数存在的理由
 * （面板宁可少画一项，也不画一个形状没核对过的数）。
 *
 * `at` 有独立含义——只有**已落库**的采样带它，故它区分「这是上一轮的读数」与「宿主此刻
 * 正在测」；缺失即现场，保持缺失；一旦出现就必须是可用的时间戳：坏时间宁可整条丢掉，
 * 也不能改标成一次从未发生的测量。
 */
function keepMetrics(raw: unknown): DagNodeMetrics | undefined {
  // `as`：路由过界的是 JSON，这里只当索引表看；每个字段都要再过一个类型谓词才收。
  const entry = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const kept: DagNodeMetrics = {};
  const tokens = measuredInt(entry['tokens']);
  if (tokens !== undefined) kept.tokens = tokens;
  const uncachedInput = measuredInt(entry['uncached_input']);
  if (uncachedInput !== undefined) kept.uncached_input = uncachedInput;
  const cacheRead = measuredInt(entry['cache_read']);
  if (cacheRead !== undefined) kept.cache_read = cacheRead;
  const cacheWrite = measuredInt(entry['cache_write']);
  if (cacheWrite !== undefined) kept.cache_write = cacheWrite;
  const output = measuredInt(entry['output']);
  if (output !== undefined) kept.output = output;
  const steps = measuredInt(entry['steps']);
  if (steps !== undefined) kept.steps = steps;
  const elapsedMs = measuredInt(entry['elapsed_ms']);
  if (elapsedMs !== undefined) kept.elapsed_ms = elapsedMs;
  // 一个数都没活下来就不是读数：绝不用 0 去猜。
  if (Object.keys(kept).length === 0) return undefined;
  if (entry['at'] !== undefined) {
    const at = measuredInt(entry['at']);
    if (at === undefined) return undefined;
    kept.at = at;
  }
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

/** 拆分项之间的分隔符：与节点盒子那一行同一个记号。 */
const BREAKDOWN_SEPARATOR = ' · ';

/**
 * 节点实测的成本构成行：`未命中 3.4k · 命中 12k · 缓存写 5k · 输出 900 · 12 步`。
 *
 * 只列宿主真的测到的项——缺项就是不画那一项，绝不当 0 补齐；一项都没有时返回
 * `undefined`，调用方据此不画这一行。**刻意不做阈值着色**：在没有实测分布之前，
 * 任何红黄绿都只是猜，而猜出来的告警会教读者忽略真实的那一个。
 */
export function metricsBreakdown(
  metrics: DagNodeMetrics | undefined,
  copy: CopyTranslate
): string | undefined {
  if (metrics === undefined) return undefined;
  const parts: string[] = [];
  const bucket = (key: CopyKey, value: number | undefined): void => {
    if (value !== undefined) parts.push(`${copy(key)} ${formatCount(value)}`);
  };
  bucket(DAG_COPY_KEYS.bucketUncached, metrics.uncached_input);
  bucket(DAG_COPY_KEYS.bucketCacheRead, metrics.cache_read);
  bucket(DAG_COPY_KEYS.bucketCacheWrite, metrics.cache_write);
  bucket(DAG_COPY_KEYS.bucketOutput, metrics.output);
  if (metrics.steps !== undefined) {
    parts.push(copy(DAG_COPY_KEYS.steps, { steps: metrics.steps }));
  }
  return parts.length === 0 ? undefined : parts.join(BREAKDOWN_SEPARATOR);
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
