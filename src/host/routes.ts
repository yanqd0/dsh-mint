/**
 * 支撑右侧边栏 mint 面板的只读 HTTP 路由。
 *
 * 已安装（静态）插件的浏览器半边到不了主机：Typert Remote 装配在构建期就固定了能力集
 * （`dsh-api-remotes`），而 `harness.handle`/`host.call` 属于*动态* Cordis 包运行器。
 * 可用的接缝是每个已发布特性都在用的那一条：主机在 `ctx.webServer` 上注册精确路由，
 * 浏览器半边 `fetch` 它们。
 *
 * 本模块能跑的东西刻意极少：每条路由一个固定子命令，外加数字/枚举参数。这里表达不出
 * 任何写操作，而且 `READ_ONLY_SUBCOMMANDS` 是被测试断言而非被信任。
 *
 * 一次请求读哪个项目由它的会话推导——绝不来自浏览器给的路径——所以面板无法被指向任意
 * 数据库。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

import { isValidDagSession, sampleOf } from '../dag/dag.js';
import type { DagSample } from '../dag/dag.js';
import { withSample } from '../dag/dag-lifecycle.js';
import { lastMeasurement, readDagMetrics } from '../dag/dag-metrics.js';
import { DAG_DIR, readDag, updateDag } from '../dag/dag-store.js';
import type { DagRead } from '../dag/dag-store.js';
import {
  isContainerDetail,
  isIssueDetail,
  isIssueItem,
  isLabelItem,
  isMilestoneItem,
  isPlanItem,
  parseDetail,
  parseItems,
} from '../mint/mint-json.js';
import type { ParsedItems } from '../mint/mint-json.js';
import { runMint } from '../mint/mint.js';
import type { MintRunOptions, MintRunResult } from '../mint/mint.js';
import type { DagNodeMetrics, DagStatus, MintDagPayload } from '../shared/records.js';
import { ROUTE_PREFIX, isRouteName } from '../shared/route-paths.js';
import { hasControlCharacter } from '../shared/text.js';
import type {
  AgentsLike,
  DshContext,
  SessionProjectionsLike,
  WebServerLike,
} from '../shared/types.js';

/**
 * 从 {@link ./route-paths.js} 再导出：该前缀与浏览器半边共用，后者为它的 `fetch`
 * 拼同样的路径。
 */
export { ROUTE_PREFIX };

/**
 * 运行中节点的实测时间要变化多少，才值得重写它已存的采样。文档落在 `/tmp`，所以这是
 * 抗抖动、不是大小上限：更短的间隔换不来任何实时读取本就已经给面板看的东西。
 */
const SAMPLE_WRITE_MS = 10_000;

/** 面板按这么多 UTF-8 字节截断 issue body。 */
export const BODY_MAX_BYTES = 256 * 1024;

/** 面板什么都没要时，分页从哪里开始。 */
export const DEFAULT_PAGE = 1;
export const DEFAULT_PAGE_SIZE = 20;
/** mint 的 `--page-size` 能吃更大，但面板不是报表。 */
export const MAX_PAGE_SIZE = 100;

/** 接受的最长过滤值；过滤条件是针，不是文档。 */
const MAX_FILTER_LENGTH = 200;

/**
 * 这些路由唯一会跑的 mint 子命令。从这里可达的一切都是读：`list`、`show`、
 * `plan list`、`plan show`、`milestone list`、`milestone show`、`label list`。
 * 任何 argv 头部不在此列的调用都是 bug——`label` 只为颜色字典而来，绝不是 `label set`。
 */
export const READ_ONLY_SUBCOMMANDS = [
  'list',
  'show',
  'plan',
  'issue',
  'milestone',
  'label',
] as const;

/** meta 路由始终执行的三次整表读，均不分页。 */
export const META_MILESTONES_ARGV: readonly string[] = [
  'milestone',
  'list',
  '--all-states',
  '--json',
  '--no-page',
];
export const META_PLANS_ARGV: readonly string[] = [
  'plan',
  'list',
  '--all-states',
  '--json',
  '--no-page',
];
export const META_LABELS_ARGV: readonly string[] = ['label', 'list', '--json', '--no-page'];

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
  /** DAG 目录覆写；默认 {@link DAG_DIR}。 */
  dagDir?: string;
  /** 挂载行的 `openDagTab`，随 DAG 信封下发；默认 true。 */
  openDagTab?: boolean;
  /** 某个会话 DAG 的逐节点实时指标；测试/精简主机上没有。 */
  readDagMetrics?(sessionId: string): Promise<Record<string, DagNodeMetrics>>;
}

/**
 * 一次进行中的请求：要应答的响应、要读的项目，以及它启动的每次 CLI 运行共用的中止信号。
 */
interface RequestScope {
  res: ServerResponse;
  cwd: string;
  signal: AbortSignal;
}

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

/** 读详情路由寻址用的数字 `id`。 */
export function parseId(params: URLSearchParams): number {
  const raw = params.get('id') ?? '';
  if (!/^\d+$/.test(raw)) throw new RouteRequestError('id must be a positive integer');
  return Number(raw);
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

function pushFilter(argv: string[], params: URLSearchParams, name: string, flag: string): void {
  const value = filterValue(params, name);
  if (value !== undefined) argv.push(flag, value);
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

/** 写一个 JSON 响应；浏览器半边只读这个 body。 */
function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  if (res.writableEnded || res.destroyed) return;
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(body);
}

/** 为面板命名一次 CLI 失败，保留 mint 自己的 stderr 建议行。 */
function failure(result: MintRunResult): Record<string, unknown> {
  const error = result.error ?? `mint exited with code ${String(result.exitCode ?? 'unknown')}`;
  const stderr = result.stderr?.trim();
  return stderr !== undefined && stderr.length > 0 ? { error, stderr } : { error };
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

/**
 * 把本进程记得、而文档还没携带的读数落盘。
 *
 * 真实主机会让已结束子级的会话在一段时间内仍可读——久到实时读取持续给出 `metrics`、
 * 面板从不丢数——所以「等实时读取失败再写」等于**永远不落盘**，每次重启都会丢掉全部
 * 测量。因此落盘要在*读数仍然实时*时就跑，并做节流：运行中的节点只有实测时间至少前进
 * {@link SAMPLE_WRITE_MS} 才重写（文档只是 `/tmp` 上几 KB，但面板的重渲染守卫让每次写
 * 仍值得拉开间隔）。已结算节点再无可累积，其最后一个读数写一次即可。
 *
 * 存的是读数自己的 `at`：那是主机*测量*该节点的时刻，不是这次写恰好跑的时刻。这里什么都
 * 不测量，所以路由仍是读者，而整步都是尽力而为——写失败只让*下一次*答案少它本该显示的
 * 兜底值。
 *
 * @param sessionId - 正在应答其文档的会话。
 * @param read - 本次请求刚从磁盘读到的内容（节点列表）。
 * @param dir - DAG 目录覆写。
 */
async function flushRememberedSample(sessionId: string, read: DagRead, dir: string): Promise<void> {
  if (read.state !== 'ok') return;
  const pending: Array<{ nodeId: string; sample: DagSample }> = [];
  for (const node of read.doc.nodes) {
    const remembered = lastMeasurement(sessionId, node.id);
    if (remembered === undefined) continue;
    const sample = sampleOf(remembered, remembered.at ?? Date.now());
    if (sample === undefined) continue;
    const stored = read.doc.samples?.[node.id];
    if (stored !== undefined && !outgrewStored(stored, sample, node.status)) continue;
    pending.push({ nodeId: node.id, sample });
  }
  if (pending.length === 0) return;
  try {
    await updateDag(
      sessionId,
      (state) => {
        if (state.state !== 'ok') return { skip: true };
        let doc = state.doc;
        const now = new Date().toISOString();
        for (const { nodeId, sample } of pending) {
          // 写入时对*当前*文档重查同一条规则，所以并发的写不会被更旧的读数覆盖。
          const stored = state.doc.samples?.[nodeId];
          const node = state.doc.nodes.find((candidate) => candidate.id === nodeId);
          if (stored !== undefined && !outgrewStored(stored, sample, node?.status ?? 'done'))
            continue;
          doc = withSample(doc, nodeId, sample, now) ?? doc;
        }
        return doc === state.doc ? { skip: true } : { doc };
      },
      dir
    );
  } catch {
    // 尽力而为：下面的答案本来就是要给面板的，而为一次*测量*的写把 200 变成错误绝不值得。
  }
}

/**
 * 一份新读数是否值得替换已存的那份。
 *
 * 已结算节点的读数是终局：已存采样就是同一次测量，所以只有数字尚不相同时才替换。运行中的
 * 节点每秒都在动，所以只有实测时间前进至少 {@link SAMPLE_WRITE_MS} 才重写——文件很小且在
 * `/tmp`，但每次轮询都写仍是面板已有实时数字的无谓抖动。
 */
function outgrewStored(stored: DagSample, fresh: DagSample, status: DagStatus): boolean {
  if (status !== 'running') {
    return stored.tokens !== fresh.tokens || stored.elapsed_ms !== fresh.elapsed_ms;
  }
  const grown =
    fresh.elapsed_ms !== undefined &&
    stored.elapsed_ms !== undefined &&
    fresh.elapsed_ms - stored.elapsed_ms >= SAMPLE_WRITE_MS;
  const tokensMoved = fresh.tokens !== undefined && fresh.tokens !== stored.tokens;
  return grown && tokensMoved;
}

/**
 * 构造路由处理器。
 *
 * @param deps - 会话查找、可选的 CLI 入口覆写，以及 run 接缝。
 * @returns 供 `ctx.webServer.register` 使用的 handler。
 */
export function createMintHandler(
  deps: MintRouteDeps
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const run = deps.run ?? runMint;
  const now = deps.now ?? Date.now;

  /**
   * 应答 plan DAG 路由。
   *
   * 这条路由**按文件寻址，不按项目寻址**：DAG 就在会话 id 旁边，不跑任何 mint CLI，而
   * 浏览器半边在其标签页可见时轮询它。所以它在活跃会话查找之前就被应答——项目解析不出来的
   * 会话仍有图可画，活得比会话久的面板退化成空态而不是 400。
   */
  const sendDag = async (res: ServerResponse, params: URLSearchParams): Promise<void> => {
    const sessionId = params.get('session') ?? '';
    // 在它能变成路径段之前先校验；坏 id 是调用方 bug。
    if (!isValidDagSession(sessionId)) {
      throw new RouteRequestError('session must be a 1-64 char [A-Za-z0-9_-] id');
    }
    const read: DagRead = await readDag(sessionId, deps.dagDir ?? DAG_DIR);
    // 宿主实测用量按设计是尽力而为：投影读不出来时面板也必须拿到图，所以这里失败等同于
    // 没有指标——而且什么都没真测到时就不发布任何东西，于是「缺失」永远不必表示「零」。
    let metrics: Record<string, DagNodeMetrics> | undefined;
    if (deps.readDagMetrics !== undefined && read.state === 'ok' && read.doc.nodes.length > 0) {
      try {
        const measured = await deps.readDagMetrics(sessionId);
        if (Object.keys(measured).length > 0) metrics = measured;
      } catch {
        metrics = undefined;
      }
    }
    // 宿主刚取的读数也是那份持久读数：把它落盘（运行中节点按间隔节流），让数字在重启后
    // 仍在——无论宿主碰巧让已结束子级的会话可读多久。
    await flushRememberedSample(sessionId, read, deps.dagDir ?? DAG_DIR);
    // `warnings` 显式声明而不推导：下面的答案携带浏览器半边读取的线格式，其中 `warnings`
    // 是可选的 `string[]`——单独推导出的 `string[]` 会把它拓宽。
    const warnings: Pick<MintDagPayload, 'warnings'> =
      read.state === 'unreadable' ? { warnings: [`unreadable dag: ${read.error}`] } : {};
    // 声明的类型就是面板读的那份线格式：节点视图因此逐字段受编译期约束，含可选的
    // 节点级 `worktree`。路由只把**已解析**的文档原样交出去，不在这里重新
    // 投影——多一处投影就是多一个会悄悄漏字段的地方。
    const payload: MintDagPayload = {
      ok: true,
      // 文件缺失与不可读都答 `dag: null`：「本会话还没有 DAG」是正常状态，不是 404。
      dag: read.state === 'ok' ? read.doc : null,
      revision: read.state === 'ok' ? read.doc.revision : 0,
      file: read.file,
      autoOpen: deps.openDagTab ?? true,
      // 整个答案共用一个采样时钟：`sampled_at` 是面板用来比对逐节点数字的基准，所以在这里
      // 只读一次。
      ...(metrics === undefined ? {} : { metrics, sampled_at: now() }),
      ...warnings,
    };
    sendJson(res, 200, payload);
  };

  /**
   * 在请求生命周期内跑 mint；客户端离开后为 `undefined`。
   *
   * 信号是请求自己的那个（{@link RequestScope}），不是本次调用的：一条并行读多张表的路由
   * （meta 路由）绝不能给每个子进程各注册一个 `close` 监听器，而一次断连应当取消它启动的
   * 每一次运行。
   */
  const runForRequest = async (
    scope: RequestScope,
    argv: string[]
  ): Promise<MintRunResult | undefined> => {
    if (scope.signal.aborted) return undefined;
    const options: MintRunOptions =
      deps.entry === undefined
        ? { signal: scope.signal }
        : { signal: scope.signal, entry: deps.entry };
    const result = await run(scope.cwd, argv, options);
    return scope.signal.aborted ? undefined : result;
  };

  const sendList = async <T>(
    scope: RequestScope,
    argv: string[],
    source: string,
    isItem: (value: unknown) => value is T,
    /**
     * 可选的选择：把解析出的页映射成要应答的那一页。缺失表示「CLI 自己的页就是答案」。
     */
    select?: (parsed: ParsedItems<T>) => ListPage<T>
  ): Promise<void> => {
    const result = await runForRequest(scope, argv);
    if (result === undefined) return;
    if (!result.ok) {
      sendJson(scope.res, 200, { ok: false, ...failure(result) });
      return;
    }
    const parsed = parseItems(source, result.text, isItem, { noun: 'list' });
    const page = select === undefined ? parsed : select(parsed);
    sendJson(scope.res, 200, {
      ok: true,
      items: page.items,
      page: page.page,
      page_size: page.pageSize,
      pages: page.pages,
      total: page.total,
      ...(parsed.warning === undefined ? {} : { warnings: [parsed.warning] }),
    });
  };

  /**
   * 按面板的已终结状态默认值提供一次容器列表。
   *
   * @param kind - 读哪张容器表。
   * @param params - 请求的 query。
   * @param page - 校验过的分页参数。
   * @param isItem - 该表记录的守卫。
   */
  const sendContainerList = async <T extends { status: string }>(
    scope: RequestScope,
    kind: 'plan' | 'milestone',
    params: URLSearchParams,
    page: PageQuery,
    isItem: (value: unknown) => value is T
  ): Promise<void> => {
    const request = containerListRequest(kind, params, page);
    await sendList(
      scope,
      request.argv,
      `${kind} list --json`,
      isItem,
      request.filterSettled ? (parsed) => settledContainerPage(parsed.items, page) : undefined
    );
  };

  /**
   * 一次应答里给出面板的查找表。
   *
   * 三张字典是互相独立的整表读，所以并行跑；逐表形状告警会被带出，一次失败即代表全部。
   *
   * 这里刻意**不再**做 issue→milestone 反查：mint 0.9.0-alpha.1 已把
   * `milestone_id` / `milestone_direct` 写在每个 `list --json` 行上，
   * 归属只随面板本就要读的 issue 列表到达，本路由不再有额外开销。这也顺带退掉了反查
   * 所需的按 milestone 缓存，`refresh=1` 随之成为空操作。
   */
  const sendMeta = async (scope: RequestScope): Promise<void> => {
    const [milestones, plans, labels] = await Promise.all([
      runForRequest(scope, [...META_MILESTONES_ARGV]),
      runForRequest(scope, [...META_PLANS_ARGV]),
      runForRequest(scope, [...META_LABELS_ARGV]),
    ]);
    if (milestones === undefined || plans === undefined || labels === undefined) return;
    // 字典读是本应答的脊柱：没有它们，面板渲染的一切都不可信，所以第一个失败即代表全部。
    const failed = [milestones, plans, labels].find((result) => !result.ok);
    if (failed !== undefined) {
      sendJson(scope.res, 200, { ok: false, ...failure(failed) });
      return;
    }

    const warnings: string[] = [];
    const milestonePage = parseItems('milestone list --json', milestones.text, isMilestoneItem, {
      noun: 'meta',
    });
    const planPage = parseItems('plan list --json', plans.text, isPlanItem, { noun: 'meta' });
    const labelPage = parseItems('label list --json', labels.text, isLabelItem, { noun: 'meta' });
    for (const warning of [milestonePage.warning, planPage.warning, labelPage.warning]) {
      if (warning !== undefined) warnings.push(warning);
    }

    sendJson(scope.res, 200, {
      ok: true,
      plans: planPage.items,
      milestones: milestonePage.items,
      labels: labelPage.items,
      ...(warnings.length === 0 ? {} : { warnings }),
    });
  };

  return async (req, res) => {
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      sendJson(res, 405, { ok: false, error: 'method-not-allowed' });
      return;
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    // 模仿宿主自己的前缀规则：`/dsh-mint/issues` 是我们的，`/dsh-mint-other` 不是。
    const name = url.pathname.startsWith(`${ROUTE_PREFIX}/`)
      ? url.pathname.slice(ROUTE_PREFIX.length + 1)
      : '';
    const params = url.searchParams;

    // 整个请求共用一个生命周期：它启动的每次 CLI 运行共用这个信号，所以一次断连取消全部，
    // 且只多挂一个监听器。
    const controller = new AbortController();
    const onClose = (): void => {
      if (!res.writableEnded) controller.abort();
    };
    res.on('close', onClose);

    try {
      if (name === 'dag') {
        await sendDag(res, params);
        return;
      }
      if (isRouteName(name)) {
        const sessionId = params.get('session') ?? '';
        const cwd = deps.getCwd(sessionId);
        if (cwd === undefined) {
          sendJson(res, 400, { ok: false, error: 'session-not-live' });
          return;
        }
        const scope: RequestScope = { res, cwd, signal: controller.signal };
        const page = parsePageQuery(params);
        switch (name) {
          case 'issues':
            await sendList(scope, buildListArgv('issue', params, page), 'list --json', isIssueItem);
            return;
          case 'plans':
            await sendContainerList(scope, 'plan', params, page, isPlanItem);
            return;
          case 'milestones':
            await sendContainerList(scope, 'milestone', params, page, isMilestoneItem);
            return;
          case 'meta':
            await sendMeta(scope);
            return;
          case 'issue': {
            const id = parseId(params);
            const result = await runForRequest(scope, buildIssueDetailArgv(id));
            if (result === undefined) return;
            if (!result.ok) {
              sendJson(res, 200, { ok: false, ...failure(result) });
              return;
            }
            const parsed = parseDetail('show --json', result.text, isIssueDetail);
            if (parsed.value === undefined) {
              sendJson(res, 200, { ok: false, error: parsed.warning ?? 'unreadable issue' });
              return;
            }
            const cut = truncateBody(parsed.value.body);
            const item = cut.truncated ? { ...parsed.value, body: cut.body } : parsed.value;
            sendJson(res, 200, { ok: true, item, truncated: cut.truncated });
            return;
          }
          default: {
            const kind = name === 'plan' ? 'plan' : 'milestone';
            const id = parseId(params);
            const result = await runForRequest(scope, buildDetailArgv(kind, id));
            if (result === undefined) return;
            if (!result.ok) {
              sendJson(res, 200, { ok: false, ...failure(result) });
              return;
            }
            const parsed = parseDetail(`${kind} show --json`, result.text, isContainerDetail);
            if (parsed.value === undefined) {
              sendJson(res, 200, { ok: false, error: parsed.warning ?? 'unreadable detail' });
              return;
            }
            sendJson(res, 200, { ok: true, [kind]: parsed.value });
            return;
          }
        }
      }
      sendJson(res, 404, { ok: false, error: 'unknown-route' });
    } catch (error) {
      if (error instanceof RouteRequestError) {
        sendJson(res, 400, { ok: false, error: error.message });
        return;
      }
      sendJson(res, 500, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      res.off('close', onClose);
    }
  };
}

/**
 * 在宿主的浏览器载体上注册面板路由。
 *
 * `webServer` 按设计可选：无头或 ACP 组合只跑插件的其它面，本就没有路由要提供。
 *
 * @param ctx - 插件的根 context。
 * @param entry - 挂载行的 `mintEntry`，转发给每一次运行。
 * @param options - 挂载行的客户端旋钮：DAG 标签页的自动打开默认值与 DAG 目录覆写。
 */
export function installMintRoutes(
  ctx: DshContext,
  entry?: string,
  options?: { openDagTab?: boolean; dagDir?: string }
): void {
  ctx.inject?.(['webServer'], (scoped) => {
    const webServer: WebServerLike | undefined = scoped.webServer;
    if (webServer === undefined) return;
    const handler = createMintHandler({
      getCwd: (sessionId) => {
        // 服务按请求现查，这样晚于本插件挂载 agent registry 的组合也解析得到；这个 cast
        // 是宿主边界上惯常的结构收窄。
        const agents = ctx.get?.('agents') as AgentsLike | undefined;
        return agents?.get(sessionId)?.session.header.cwd;
      },
      // 与 `getCwd` 同样的现查，理由相同：投影注册表可能在本插件启动后才挂载。
      // `projections` 即使缺失也照转——降级规则（`{}`）归 `readDagMetrics` 独有，
      // 于是没有第二处需要同步。
      readDagMetrics: (sessionId) => {
        const agents = ctx.get?.('agents') as AgentsLike | undefined;
        const projections = ctx.get?.('sessionProjections') as SessionProjectionsLike | undefined;
        return readDagMetrics({
          sessionId,
          ...(options?.dagDir === undefined ? {} : { dagDir: options.dagDir }),
          agents,
          projections,
          sampledMs: Date.now(),
        });
      },
      ...(entry === undefined ? {} : { entry }),
      ...(options?.openDagTab === undefined ? {} : { openDagTab: options.openDagTab }),
      ...(options?.dagDir === undefined ? {} : { dagDir: options.dagDir }),
    });
    const register = (): (() => void) =>
      webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler });
    if (scoped.effect !== undefined) {
      scoped.effect(register, 'dsh-mint: client query routes');
      return;
    }
    // 没有 `effect` 的精简 context 也照样能用这些路由；只是没人持有 disposer，而那仅在热重载
    // 时才有影响。
    register();
  });
}
