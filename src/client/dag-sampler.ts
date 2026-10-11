/**
 * DAG 面板的纯逻辑：把一次作答归约成「可比较的读数」与「可绘制的时间」。
 *
 * 与 `DagBody.tsx` 分开是为了让这一族（轮询守卫的比较、样本老化）留在 `.ts`：
 * `.tsx` 组件不进覆盖口径，而这里的每一支都是可测的分支。
 */
import type { DagNodeMetrics, DagNodeView, MintDagPayload } from '../shared/records.js';
import { liveElapsedMs, nodeMetricsMap } from './dag-model.js';

/**
 * 一次作答的身份：revision 说文件动没动，sample 说数字动没动——两者齐备，才能把「同一个
 * 读数读了两次」与「同一份文档、刚重新量过」区分开。
 */
export interface DagSample {
  revision: number;
  sampledAt: number | undefined;
  metrics: Record<string, DagNodeMetrics> | undefined;
}

export function sampleOf(payload: MintDagPayload): DagSample {
  return { revision: payload.revision, sampledAt: payload.sampled_at, metrics: payload.metrics };
}

/**
 * 两次作答是否读的是同一份文档、同一组数字。
 *
 * 只有 revision 与样本都不变，重设 state 才是纯粹的重画：同一张图、同一组数字，代价却是
 * 一次渲染。两个 map 又小又扁，逐字段比对比序列化一遍更便宜也更精确。
 */
export function sameSample(previous: DagSample | undefined, next: DagSample): boolean {
  if (previous === undefined) return false;
  if (previous.revision !== next.revision) return false;
  if (previous.sampledAt !== next.sampledAt) return false;
  return sameMetrics(previous.metrics, next.metrics);
}

/**
 * 一张读数表里参与比较的字段：四桶、步数、时长与落库戳。
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
  'elapsed_ms',
  'at',
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
 * 一份 payload 可以据以作画的分节点实测，已过滤完毕。
 *
 * 过滤在 `nodeMetricsMap` 里：它丢掉文档已不再携带的、以及半截样本弄错的。这里对
 * `metrics` 的分支则把调用留在 `exactOptionalPropertyTypes` 之内——显式的 `undefined`
 * 与缺席的字段并不等同。
 */
export function sampleMetrics(payload: MintDagPayload | undefined): Record<string, DagNodeMetrics> {
  if (payload?.metrics === undefined) return {};
  return nodeMetricsMap({ dag: payload.dag, metrics: payload.metrics });
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
