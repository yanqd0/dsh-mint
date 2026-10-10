/**
 * 面板的传输层：用 `fetch` 打宿主那组只读的 `/dsh-mint/` 路由。
 *
 * 路径对 `document.baseURI` 解析而非对 origin——页面可能挂在某个前缀下（反向代理、一个
 * 宿主后面挂多份部署），写成根绝对的路径会漏掉前缀而 404。所有失败都以
 * `{ ok: false, error }` 返回而不抛：会话已死、mint 入口坏掉、CLI 失败，面板渲染的是
 * 同一个失败态。
 */
import type {
  ContainerDetail,
  IssueItem,
  MilestoneItem,
  MintDagPayload,
  MintDetailPayload,
  MintFailurePayload,
  MintIssuePayload,
  MintListPayload,
  MintMetaPayload,
  MintResponse,
  PlanItem,
} from '../shared/records.js';
import { routePath } from '../shared/route-paths.js';
import type { MintApiLike } from './types.js';

/**
 * 每条路由的路径都从宿主自己的路由表推出：宿主的 `ROUTE_NAMES` 与本表必须描述同一组
 * 路径，而只有比对才能让它保持如此，故这里导出给漂移守卫用。
 */
export const ROUTES = {
  issues: routePath('issues'),
  plans: routePath('plans'),
  milestones: routePath('milestones'),
  issue: routePath('issue'),
  plan: routePath('plan'),
  milestone: routePath('milestone'),
  meta: routePath('meta'),
  dag: routePath('dag'),
} as const;

/**
 * 把路由路径解析到页面所在的目录下。
 *
 * `baseUri` 缺省取 `document.baseURI`；非浏览器调用方（测试）退回 origin。
 */
export function apiPath(path: string, baseUri?: string): string {
  const relative = path.replace(/^\/+/, '');
  const base = baseUri ?? (typeof document === 'undefined' ? '/' : document.baseURI);
  return new URL(relative, new URL(base, 'http://localhost/')).pathname;
}

export function queryString(query: Record<string, string | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== '') params.set(key, value);
  }
  const text = params.toString();
  return text.length === 0 ? '' : `?${text}`;
}

/** 路由与本模块共用的一种失败信封的判定。 */
function isFailure(value: unknown): value is MintFailurePayload {
  return typeof value === 'object' && value !== null && (value as { ok?: unknown }).ok === false;
}

export interface CreateApiOptions {
  /** 每个请求都按它去读该会话的项目。 */
  sessionId: string;
  /** 测试缝；缺省用页面的 `fetch`。 */
  fetch?: typeof globalThis.fetch;
  /** 挂载点的测试缝；缺省用 `document.baseURI`。 */
  baseUri?: string;
}

export function createApi(options: CreateApiOptions): MintApiLike {
  const doFetch = options.fetch ?? globalThis.fetch;
  const { sessionId } = options;

  const get = async <T extends { ok: true }>(
    path: string,
    query: Record<string, string | undefined>,
    signal?: AbortSignal
  ): Promise<MintResponse<T>> => {
    const url = `${apiPath(path, options.baseUri)}${queryString({ session: sessionId, ...query })}`;
    try {
      const response = await doFetch(url, {
        method: 'GET',
        headers: { accept: 'application/json' },
        ...(signal === undefined ? {} : { signal }),
      });
      const text = await response.text();
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        return {
          ok: false,
          error: `HTTP ${String(response.status)}: ${text.slice(0, 200) || '(empty body)'}`,
        };
      }
      if (isFailure(raw)) return raw;
      if (!response.ok) return { ok: false, error: `HTTP ${String(response.status)}` };
      return raw as T;
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  };

  return {
    issues: (query, signal) => get<MintListPayload<IssueItem>>(ROUTES.issues, query, signal),
    plans: (query, signal) => get<MintListPayload<PlanItem>>(ROUTES.plans, query, signal),
    milestones: (query, signal) =>
      get<MintListPayload<MilestoneItem>>(ROUTES.milestones, query, signal),
    issue: (id, signal) => get<MintIssuePayload>(ROUTES.issue, { id: String(id) }, signal),
    meta: (signal) => get<MintMetaPayload>(ROUTES.meta, {}, signal),
    plan: (id, signal) =>
      get<MintDetailPayload<ContainerDetail>>(ROUTES.plan, { id: String(id) }, signal),
    milestone: (id, signal) =>
      get<MintDetailPayload<ContainerDetail>>(ROUTES.milestone, { id: String(id) }, signal),
    // DAG 路由除会话外不接受查询参数：探测与面板读的是同一份按会话落盘的文件。
    dag: (signal) => get<MintDagPayload>(ROUTES.dag, {}, signal),
  };
}
