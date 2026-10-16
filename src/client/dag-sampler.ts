/**
 * 面板轮询的「同一份读数」守卫。
 *
 * 两个 tab 读两条不同的路由，但跳过重渲的判据是同一件事：**revision 没变、数字也没变**。
 * `revision` 单独不够（DAG 的数字来自宿主实测，文档不动时数字仍在变；子代理树的 `running`
 * 更是随时会翻面），`sampled_at` 单独也不够（静止的图会每 2s 被无谓重渲一次）。
 *
 * 与 `DagBody.tsx` 分开是为了让这一族留在 `.ts`：`.tsx` 组件不进覆盖口径，而这里的每一支
 * 都是可测的分支。
 */
import type {
  AgentNodeView,
  DagNodeMetrics,
  DagNodeView,
  DagView,
  MintAgentsPayload,
} from '../shared/records.js';
import { liveElapsedMs, nodeMetricsMap } from './dag-model.js';

/** 能做「同一份读数」比较的最小信封：DAG 与子代理树都满足它。 */
export interface ReadSampleInput {
  revision: number;
  sampled_at?: number;
  metrics?: Record<string, DagNodeMetrics>;
}

/**
 * 一次作答的身份：revision 说文件/数据动没动，sample 说数字动没动——两者齐备，才能把
 * 「同一个读数读了两次」与「同一份数据、刚重新量过」区分开。
 */
export interface ReadSample {
  revision: number;
  sampledAt: number | undefined;
  metrics: Record<string, DagNodeMetrics> | undefined;
}

/**
 * 把任意带这三个字段的信封(révision / sample clock / metrics)读成可比较的读数。
 */
export function sampleOf(payload: ReadSampleInput): ReadSample {
  return { revision: payload.revision, sampledAt: payload.sampled_at, metrics: payload.metrics };
}

/** 子代理树的读数与 DAG 同形：`revision` 来自落盘的兜底快照（live 读数缺省为 0），但没有可据以老化的采样锚点。 */
export type DagSample = ReadSample;

/**
 * 两次作答是否读的是同一份文档、同一组数字。
 *
 * 只有 revision 与样本都不变，重设 state 才是纯粹的重画：同一张图、同一组数字，代价却是
 * 一次渲染。两个 map 又小又扁，逐字段比对比序列化一遍更便宜也更精确。
 */
export function sameSample(previous: ReadSample | undefined, next: ReadSample): boolean {
  if (previous === undefined) return false;
  if (previous.revision !== next.revision) return false;
  if (previous.sampledAt !== next.sampledAt) return false;
  return sameMetrics(previous.metrics, next.metrics);
}

/**
 * 一张读数表里参与比较的字段：四桶、步数、上下文、时长与落库戳。
 *
 * 逐字段收齐是刻意的——漏一个字段就等于「那一项变了也不重画」，面板会一直画旧值。
 */
const METRIC_FIELDS = [
  'tokens',
  'uncached_input',
  'cache_read',
  'cache_write',
  'output',
  'steps',
  'context',
  'elapsed_ms',
  'at',
  'agentTag',
] as const satisfies readonly (keyof DagNodeMetrics)[];

function sameEntry(before: DagNodeMetrics, after: DagNodeMetrics): boolean {
  return METRIC_FIELDS.every((field) => before[field] === after[field]);
}

function sameMetrics(
  before: Record<string, DagNodeMetrics> | undefined,
  after: Record<string, DagNodeMetrics> | undefined
): boolean {
  if (before === after) return true;
  if (before === undefined || after === undefined) return false;
  const ids = Object.keys(before);
  if (ids.length !== Object.keys(after).length) return false;
  return ids.every((id) => {
    const first = before[id];
    const second = after[id];
    return first !== undefined && second !== undefined && sameEntry(first, second);
  });
}

/**
 * 一份 DAG payload 可以据以作画的分节点实测，已过滤完毕。
 *
 * 过滤在 `nodeMetricsMap` 里：它丢掉文档已不再携带的、以及半截样本弄错的。不能据以作画
 * （没有文档或没有读数）就是空表——绝不半信半疑地画一半。
 */
export function sampleMetrics(
  payload: { dag?: DagView | null; metrics?: Record<string, DagNodeMetrics> } | undefined
): Record<string, DagNodeMetrics> {
  if (payload?.metrics === undefined) return {};
  return nodeMetricsMap({ dag: payload.dag ?? null, metrics: payload.metrics });
}

/**
 * 子代理树的一次读数折成同一套「可比较的读数」。
 *
 * 节点 id 就是键，值是这一行的复合读数：`running` 折进 `steps`（0/1），`label` 折进
 * `agentTag`（FNV-1a 指纹），三项数字照抄。**只取会变的那几项**：`depth`/`parent`/`mode`
 * 由宿主保证在会话内不变，把它们也算进来只会让比较多几位。
 *
 * `sampledAt` **刻意留空**：这条路由每次应答都会读一次钟，若把 `sampled_at` 算进身份，面板
 * 每 2s 都会因为「时钟不同」而重渲一次——而它恰恰是这里唯一不该参与判定的字段（走秒的锚由
 * 返回值自己带着，不需要守卫替它把关）。兜底快照自带稳定的 `revision`（只在树真变了时才前进），
 * 所以 live 与兜底之间的切换、以及兜底内部的一次重写，都靠它触发重渲。
 */
export function agentSampleOf(payload: MintAgentsPayload): ReadSample {
  const metrics: Record<string, DagNodeMetrics> = {};
  for (const node of payload.nodes) metrics[node.id] = agentCompact(node);
  return { revision: payload.revision ?? 0, sampledAt: undefined, metrics };
}

/**
 * 一个节点里**能变**的那几项，折成一条记录。
 *
 * 只要 `AgentTreeBody` 会画的东西都必须在这里出现：漏一项就等于「它变了也不重画」。
 * 数字用原值（不是格式化后的字符串），坏值一律不收——与 `agent-tree-model` 的白名单一致。
 */
function agentCompact(node: AgentNodeView): DagNodeMetrics {
  const compact: DagNodeMetrics = { steps: node.running ? 1 : 0, agentTag: hash(node.label) };
  for (const field of ['tokens', 'context', 'elapsed_ms'] as const) {
    const value = node.metrics?.[field];
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
      compact[field] = value;
    }
  }
  return compact;
}

/** 一个字符串的稳定小数字（只用于比较，不用于展示）：FNV-1a 的 32 位版本。 */
function hash(text: string): number {
  let value = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  return value;
}

/**
 * 节点这一行此刻该画的耗时。
 *
 * running 的节点还在动：宿主只采过一次时间，此后每一秒都是浏览器自己数的——`liveElapsedMs`
 * 正是把这件事锚在样本的时钟上。已结算节点的耗时就是那次样本本身，不得随 `now` 漂移，因为
 * 已经没有东西在累加。
 *
 * **落库**样本（带 `at`）是 running 节点唯一停止计数的情形：这条读数描述的是宿主早些时候
 * 量过的子代理——它的会话已经没了——再按浏览器时钟老化就等于声称这段时长它从未跑过。它照旧
 * 显示，就用宿主给的数（`?` 会藏起一个真实的测量值），日期由卡片标注。
 */
export function measuredTimeMs(
  node: DagNodeView,
  metrics: DagNodeMetrics | undefined,
  sampledAtMs: number | undefined,
  nowMs: number
): number | undefined {
  if (metrics?.at !== undefined) return metrics.elapsed_ms;
  if (node.status !== 'running') return metrics?.elapsed_ms;
  return liveElapsedMs(metrics?.elapsed_ms, sampledAtMs, nowMs);
}

/** 落库样本的时间戳按本地钟读；标签由 copy 提供。 */
export function measuredAtLabel(at: number): string {
  return new Date(at).toLocaleTimeString();
}
