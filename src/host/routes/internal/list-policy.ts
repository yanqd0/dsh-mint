/**
 * 容器与 issue 列表的策略：白名单、结束态过滤、分页重算与 argv 拼装。
 *
 * 这一层是**纯函数**（不碰 HTTP、不跑 CLI），因为面板「默认只看未结束」、「--page-size 上限」
 * 这类口径只有一处定义才守得住；处理器只按它的输出应答。
 */
import { hasControlCharacter } from '../../../shared/text.js';
import { RouteRequestError } from './request-scope.js';
import type { ListKind, PageQuery } from './request-scope.js';

/** 接受的最长过滤值；过滤条件是针，不是文档。 */
const MAX_FILTER_LENGTH = 200;

/**
 * 读一个过滤值。
 *
 * 值不得以 `-` 起头——那会让它变成 CLI 的旗标——也不得带控制字符。既然 `spawn` 收的是
 * argv 数组，就没有 shell 需要转义，所以这两条规则加上固定子命令就是全部的注入面。
 */
export function filterValue(params: URLSearchParams, name: string): string | undefined {
  const raw = params.get(name);
  if (raw === null) return undefined;
  const value = raw.trim();
  if (value.length === 0) return undefined;
  if (value.length > MAX_FILTER_LENGTH) throw new RouteRequestError(`${name} is too long`);
  if (value.startsWith('-')) throw new RouteRequestError(`${name} must not start with "-"`);
  if (hasControlCharacter(value)) throw new RouteRequestError(`${name} has control characters`);
  return value;
}

function pushFilter(argv: string[], params: URLSearchParams, name: string, flag: string): void {
  const value = filterValue(params, name);
  if (value !== undefined) argv.push(flag, value);
}

/**
 * 为一条 `list` 路由拼 argv。
 *
 * 这是直通形态：一次调用能表达的旗标都照搬。容器路由改走
 * {@link containerListRequest}，后者在面板「open or running」默认值需要整表读时覆盖它；
 * issue 路由是直接调用本函数的唯一调用方。
 *
 * @param kind - 读哪个集合。
 * @param params - 请求的 query。
 * @param page - 校验过的分页参数。
 * @throws {RouteRequestError} 过滤值格式非法时抛出。
 */
export function buildListArgv(kind: ListKind, params: URLSearchParams, page: PageQuery): string[] {
  const argv = kind === 'issue' ? ['list', '--json'] : [kind, 'list', '--json'];
  if (kind === 'issue') {
    if (params.get('allStates') === '1') {
      argv.push('--all-states');
    } else {
      const status = filterValue(params, 'status');
      if (status !== undefined) argv.push('--status', status);
    }
    pushFilter(argv, params, 'priority', '--priority');
    pushFilter(argv, params, 'label', '--label');
    pushFilter(argv, params, 'plan', '--plan');
    pushFilter(argv, params, 'milestone', '--milestone');
    pushFilter(argv, params, 'search', '--search');
  } else {
    // 容器（plan | milestone）：`--all-states` 压过 `--status`，与 issue 分支同样的
    // 优先级——两者互相矛盾，面板也从不一起发。
    if (params.get('allStates') === '1') argv.push('--all-states');
    else pushFilter(argv, params, 'status', '--status');
    pushFilter(argv, params, 'milestone', '--milestone');
    pushFilter(argv, params, 'search', '--search');
  }
  argv.push('--page', String(page.page), '--page-size', String(page.pageSize));
  return argv;
}

/**
 * 拼读一条 issue 全文的 argv。
 *
 * `show --json` 是唯一同时携带列表字段与 body 的读，这才让 plan 或 milestone 详情能在
 * 不做第二次查询、也不发明列表里没有的字段的前提下打开 issue。
 */
export function buildIssueDetailArgv(id: number): string[] {
  return ['show', String(id), '--json'];
}

/** 拼读一个容器详情的 argv（`plan show` / `milestone show`）。 */
export function buildDetailArgv(kind: 'plan' | 'milestone', id: number): string[] {
  return [kind, 'show', String(id), '--json'];
}

/**
 * 面板视为已终结的容器状态。
 *
 * mint 自己的 `plan list` / `milestone list` 只隐藏 `done`，但 `partial`（子级全部了结、
 * 从未发布）与 `dropped`（取消）也是容器的终结态。这里只点名这三种：mint 将来新增的状态
 * 会继续保持可见，而不是悄悄消失。
 */
export const CONTAINER_END_STATES: readonly string[] = ['partial', 'dropped', 'done'];

/** 一次容器列表请求：要跑的 argv，以及怎么读它的答案。 */
export interface ContainerListRequest {
  argv: string[];
  /**
   * {@link argv} 是否读了整表（`--no-page`）：路由必须自己丢掉已终结容器并切出请求页。
   */
  filterSettled: boolean;
}

/**
 * 拼 `/dsh-mint/plans` 或 `/dsh-mint/milestones` 背后的请求。
 *
 * 面板默认「open or running」，而 mint 无法被这样问：它自己的默认只隐藏 `done`，而
 * `--status` 只接受单个值（重复旗标是用法错误）。所以默认路径改读整张 all-states 表——
 * 与 meta 路由本来就在做的同一次读——再由 {@link settledContainerPage} 在这里过滤并分页。
 *
 * 显式给了 `status` 或 `allStates` 则能用一次 CLI 调用表达，直接放行。
 *
 * @param kind - 读哪个容器列表。
 * @param params - 请求的 query。
 * @param page - 校验过的分页参数。
 * @throws {RouteRequestError} 过滤值格式非法时抛出。
 */
export function containerListRequest(
  kind: 'plan' | 'milestone',
  params: URLSearchParams,
  page: PageQuery
): ContainerListRequest {
  if (params.get('allStates') === '1' || filterValue(params, 'status') !== undefined) {
    return { argv: buildListArgv(kind, params, page), filterSettled: false };
  }
  const argv = [kind, 'list', '--all-states', '--json', '--no-page'];
  pushFilter(argv, params, 'milestone', '--milestone');
  pushFilter(argv, params, 'search', '--search');
  return { argv, filterSettled: true };
}

/** 一条 list 路由在应用选择之后给出的那一页。 */
export interface ListPage<T> {
  items: T[];
  page: number;
  pageSize: number;
  pages: number;
  total: number;
}

/**
 * 丢掉已终结容器，并从剩下的里切出请求页。
 *
 * `--no-page` 仍会带上 mint 对**未过滤**表的计数，所以总数与切片都在这里重算。
 *
 * @param items - CLI 返回的全部容器。
 * @param page - 调用方要的那一页。
 */
export function settledContainerPage<T extends { status: string }>(
  items: readonly T[],
  page: PageQuery
): ListPage<T> {
  const active = items.filter((item) => !CONTAINER_END_STATES.includes(item.status));
  const total = active.length;
  const start = (page.page - 1) * page.pageSize;
  return {
    items: active.slice(start, start + page.pageSize),
    page: page.page,
    pageSize: page.pageSize,
    pages: total === 0 ? 1 : Math.ceil(total / page.pageSize),
    total,
  };
}
