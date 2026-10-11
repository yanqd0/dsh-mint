/**
 * 面板路由的处理器：prefix 匹配、各类应答，以及路由注册。
 *
 * 从 `routes.ts` 拆出（`max-lines` 门禁）：入口只做再导出，纯请求面与容器策略各自落
 * `request-scope.ts` / `list-policy.ts`；本文件是唯一碰 `IncomingMessage`/`ServerResponse`
 * 与 CLI 执行的地方。
 *
 * 与 mint CLI 相关的两条路由此处**按项目**取数（会话 → cwd → 一个固定子命令），而
 * `/dsh-mint/dag` 与 `/dsh-mint/agents` 是**按会话**取数的例外：前者读 `/tmp` 的文档、
 * 后者读宿主内存里的注册表与投影，都不 spawn CLI，也都不做在线会话门禁。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

import { collectAgentTree } from '../../../dag/agent-tree/agent-tree.js';
import type { AgentTreeRead } from '../../../dag/agent-tree/agent-tree.js';
import { AGENT_TREE_DIR, readAgentTreeDoc } from '../../../dag/agent-tree/agent-tree-store.js';
import type { AgentTreeFileRead } from '../../../dag/agent-tree/agent-tree-store.js';
import { isValidDagSession, sampleOf } from '../../../dag/dag.js';
import type { DagSample } from '../../../dag/dag.js';
import { withSample } from '../../../dag/dag-lifecycle.js';
import {
  lastMeasurement,
  readDagMetrics,
  sameSampleNumbers,
  sampleNumbersMoved,
} from '../../../dag/dag-metrics.js';
import { DAG_DIR, readDag, updateDag } from '../../../dag/dag-store.js';
import type { DagRead } from '../../../dag/dag-store.js';
import {
  isContainerDetail,
  isIssueDetail,
  isIssueItem,
  isLabelItem,
  isMilestoneItem,
  isPlanItem,
  parseDetail,
  parseItems,
} from '../../../mint/mint-json.js';
import type { ParsedItems } from '../../../mint/mint-json.js';
import { runMint } from '../../../mint/mint.js';
import type { MintRunOptions, MintRunResult } from '../../../mint/mint.js';
import { flushAgentSnapshot } from './agent-snapshot.js';
import type { DagNodeMetrics, DagStatus, MintDagPayload } from '../../../shared/records.js';
import { ROUTE_PREFIX, isRouteName } from '../../../shared/route-paths.js';
import type {
  AgentsLike,
  DshContext,
  SessionProjectionsLike,
  SessionsLike,
  WebServerLike,
} from '../../../shared/types.js';
import { META_LABELS_ARGV, META_MILESTONES_ARGV, META_PLANS_ARGV } from './cli-surface.js';
import {
  buildDetailArgv,
  buildIssueDetailArgv,
  buildListArgv,
  containerListRequest,
  settledContainerPage,
} from './list-policy.js';
import type { ListPage } from './list-policy.js';
import { RouteRequestError, parseId, parsePageQuery, truncateBody } from './request-scope.js';
import type { MintRouteDeps, PageQuery, RequestScope } from './request-scope.js';

/**
 * 运行中节点的实测时间要变化多少，才值得重写它已存的采样。文档落在 `/tmp`，所以这是
 * 抗抖动、不是大小上限：更短的间隔换不来任何实时读取本就已经给面板看的东西。
 */
const SAMPLE_WRITE_MS = 10_000;

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
 *
 * 逐字段比较（含四桶与步数）由 `dag-metrics.ts` 的清单负责，字段集只有那一处定义，新增
 * 字段不会在这里被漏掉。
 */
function outgrewStored(stored: DagSample, fresh: DagSample, status: DagStatus): boolean {
  if (status !== 'running') return !sameSampleNumbers(stored, fresh);
  const grown =
    fresh.elapsed_ms !== undefined &&
    stored.elapsed_ms !== undefined &&
    fresh.elapsed_ms - stored.elapsed_ms >= SAMPLE_WRITE_MS;
  // 时长本身由 `grown` 把关节流，这里只看四桶/步数/求和有没有动。
  return grown && sampleNumbersMoved(stored, fresh);
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
   * 应答子代理树路由。
   *
   * 与 {@link sendDag} 同一族：**按会话寻址，不按项目**——读数全在宿主内存里（agent 与会话
   * 注册表 + 三个会话投影），不跑 mint CLI，所以也在活跃会话查找之前应答；兜底那份文档同样按
   * 会话 id 寻址。
   *
   * 答案分三种：读到非空实时树就答它、顺手落一份快照；读不到实时树而盘上有快照就答快照
   * （`stale`，`running` 一律按已结束下发）；两者都没有就是空树。只有第三种里的「文档不可读」
   * 会在 `warnings` 里点名，服务缺失或抛错仍然只是空树——面板宁可画空树，不接受失败页。
   */
  const sendAgents = async (res: ServerResponse, params: URLSearchParams): Promise<void> => {
    const sessionId = params.get('session') ?? '';
    if (!isValidDagSession(sessionId)) {
      throw new RouteRequestError('session must be a 1-64 char [A-Za-z0-9_-] id');
    }
    const agentsDir = deps.agentsDir ?? AGENT_TREE_DIR;
    // 一次请求只读一次钟：信封的 `sampled_at` 就是这次读数的基准，面板据它走秒。
    const sampledMs = now();
    let read: AgentTreeRead;
    try {
      read = (await deps.readAgentTree?.(sessionId, sampledMs)) ?? {
        nodes: [],
        counts: { total: 0, running: 0, unsupported: 0 },
      };
    } catch {
      // 树的读取是尽力而为：一个注册表塌了也不能把 200 变成 500（面板宁可画空树）。
      read = { nodes: [], counts: { total: 0, running: 0, unsupported: 0 } };
    }
    // 活着的服务答得出东西，就以它为准；这也是快照的唯一写入时机——快照只能取自真实读数，
    // 绝不能把上一次的旧树再写回去变成新的旧树。
    if (read.nodes.length > 0) {
      await flushAgentSnapshot({ sessionId, read, dir: agentsDir, sampledMs });
      sendJson(res, 200, {
        ok: true,
        nodes: read.nodes,
        counts: read.counts,
        sampled_at: sampledMs,
        revision: 0,
        ...(read.warnings === undefined || read.warnings.length === 0
          ? {}
          : { warnings: read.warnings }),
      });
      return;
    }
    let stored: AgentTreeFileRead | undefined;
    try {
      stored = await readAgentTreeDoc(sessionId, agentsDir);
    } catch {
      // 路径校验在路由入口已经做过，这里只兜住其余意外：读不到快照就是没有快照。
      stored = undefined;
    }
    if (stored?.state === 'ok') {
      const { doc } = stored;
      sendJson(res, 200, {
        ok: true,
        // 快照里的 `running` 说的是一次过去的读数：会话已不在，一律按已结束下发，
        // 否则面板会为一段不会再动的旧读数起走秒定时器。
        nodes: doc.nodes.map((node) => ({ ...node, running: false })),
        counts: {
          total: doc.nodes.length,
          running: 0,
          unsupported: read.counts.unsupported,
        },
        sampled_at: doc.sampled_at,
        revision: doc.revision,
        file: stored.file,
        stale: true,
      });
      return;
    }
    const warnings = [
      ...(read.warnings ?? []),
      ...(stored?.state === 'unreadable' ? [`unreadable agent tree: ${stored.error}`] : []),
    ];
    sendJson(res, 200, {
      ok: true,
      nodes: [],
      counts: read.counts,
      sampled_at: sampledMs,
      ...(warnings.length === 0 ? {} : { warnings }),
    });
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
      if (name === 'agents') {
        await sendAgents(res, params);
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
 * @param options - 挂载行的客户端旋钮：DAG 标签页的自动打开默认值，以及 DAG / 子代理树两个目录覆写。
 */
export function installMintRoutes(
  ctx: DshContext,
  entry?: string,
  options?: { openDagTab?: boolean; dagDir?: string; agentsDir?: string }
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
      // 与上面同一条纪律：两个服务都在**每次请求**现查（它们可能晚于本插件挂载），
      // 缺失不是错误——`collectAgentTree` 自己把「读不到」翻译成空树加一条说明。
      readAgentTree: (sessionId, sampledMs) =>
        Promise.resolve(
          collectAgentTree({
            rootId: sessionId,
            agents: ctx.get?.('agents') as AgentsLike | undefined,
            sessions: ctx.get?.('sessions') as SessionsLike | undefined,
            projections: ctx.get?.('sessionProjections') as SessionProjectionsLike | undefined,
            sampledMs,
          })
        ),
      ...(entry === undefined ? {} : { entry }),
      ...(options?.openDagTab === undefined ? {} : { openDagTab: options.openDagTab }),
      ...(options?.dagDir === undefined ? {} : { dagDir: options.dagDir }),
      ...(options?.agentsDir === undefined ? {} : { agentsDir: options.agentsDir }),
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
