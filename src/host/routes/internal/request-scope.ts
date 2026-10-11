/**
 * 面板路由的请求面：依赖缝、分页参数、过滤值与数字 id。
 *
 * 这些是处理器与它的调用方共用的形状（`MintRouteDeps` 的缝由 `installMintRoutes` 填），
 * 故与 mint CLI 面、容器策略分开落：改一个查询参数不该动到路由分发。
 */
import type { ServerResponse } from 'node:http';

import type { DagNodeMetrics } from '../../../shared/records.js';
import type { AgentTreeRead } from '../../../dag/agent-tree/agent-tree.js';
import type { MintRunOptions, MintRunResult } from '../../../mint/mint.js';

/** 这些路由拒绝的一次请求：路径坏、id 坏或过滤值坏。 */
export class RouteRequestError extends Error {}

/** `list` 路由读的是哪个集合。 */
export type ListKind = 'issue' | 'plan' | 'milestone';

/** 校验过的分页参数。 */
export interface PageQuery {
  page: number;
  pageSize: number;
}

/** `run` 接缝：测试驱动路由时因此无需 mock 模块。 */
export type MintRunner = (
  cwd: string,
  args: readonly string[],
  options?: MintRunOptions
) => Promise<MintRunResult>;

export interface MintRouteDeps {
  /** 解析活跃会话的项目目录；未知会话为 `undefined`。 */
  getCwd(sessionId: string): string | undefined;
  /** mint CLI 入口覆写（挂载行的 `mintEntry`）。 */
  entry?: string;
  /** 缺省 {@link runMint}；测试会替换它。 */
  run?: MintRunner;
  /** DAG 应答里 `sampled_at` 的时钟缝；默认 `Date.now`。 */
  now?: () => number;
  /** DAG 目录覆写；默认 `DAG_DIR`。 */
  dagDir?: string;
  /** 子代理树文档目录覆写；默认 `AGENT_TREE_DIR`。 */
  agentsDir?: string;
  /** 挂载行的 `openDagTab`，随 DAG 信封下发；默认 true。 */
  openDagTab?: boolean;
  /** 某个会话 DAG 的逐节点实时指标；测试/精简主机上没有。 */
  readDagMetrics?(sessionId: string): Promise<Record<string, DagNodeMetrics>>;
  /**
   * 某个会话的子代理树；测试/精简主机上没有（缺了只答空树，不是错误）。
   *
   * `sampledMs` 由路由只读一次并同时用作信封的 `sampled_at`，所以读数与它的钟同源。
   */
  readAgentTree?(sessionId: string, sampledMs: number): Promise<AgentTreeRead>;
}

/**
 * 一次进行中的请求：要应答的响应、要读的项目，以及它启动的每次 CLI 运行共用的中止信号。
 */
export interface RequestScope {
  res: ServerResponse;
  cwd: string;
  signal: AbortSignal;
}

/** 面板按这么多 UTF-8 字节截断 issue body。 */
export const BODY_MAX_BYTES = 256 * 1024;

/** 面板什么都没要时，分页从哪里开始。 */
export const DEFAULT_PAGE = 1;
export const DEFAULT_PAGE_SIZE = 20;
/** mint 的 `--page-size` 能吃更大，但面板不是报表。 */
export const MAX_PAGE_SIZE = 100;

/** 读 `page` / `pageSize`：缺失取默认，格式非法即 400。 */
export function parsePageQuery(params: URLSearchParams): PageQuery {
  return {
    page: pageCounter(params.get('page'), DEFAULT_PAGE, Number.MAX_SAFE_INTEGER),
    pageSize: pageCounter(params.get('pageSize'), DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE),
  };
}

function pageCounter(raw: string | null, fallback: number, max: number): number {
  if (raw === null) return fallback;
  if (!/^\d+$/.test(raw)) throw new RouteRequestError(`not a page number: ${raw}`);
  return Math.min(Math.max(Number(raw), 1), max);
}

/** 读详情路由寻址用的数字 `id`。 */
export function parseId(params: URLSearchParams): number {
  const raw = params.get('id') ?? '';
  if (!/^\d+$/.test(raw)) throw new RouteRequestError('id must be a positive integer');
  return Number(raw);
}

/**
 * 在 UTF-8 边界上截断 body，并报告是否切过。
 *
 * `null` 是 mint 自己的「没有 body」答案，原样放行：面板把 `null` 与 `''` 都渲染成空态，
 * 所以这里无需归一化，也无需编造。
 *
 * @param text - 记录 body；没有时为 `null`。
 */
export function truncateBody(text: string | null): { body: string | null; truncated: boolean } {
  if (text === null) return { body: null, truncated: false };
  if (Buffer.byteLength(text, 'utf8') <= BODY_MAX_BYTES) return { body: text, truncated: false };
  // 字节长度对前缀长度单调，所以二分找最长的可容纳前缀，而不是逐字符回退。
  let low = 0;
  let high = Math.min(text.length, BODY_MAX_BYTES);
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, mid), 'utf8') <= BODY_MAX_BYTES) low = mid;
    else high = mid - 1;
  }
  // 绝不留下落单的代理项：星光平面的字符是一对。
  if (low > 0 && /[\uD800-\uDBFF]/.test(text.charAt(low - 1))) low -= 1;
  return { body: text.slice(0, low), truncated: true };
}
