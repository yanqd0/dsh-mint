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
 *
 * 本文件是**入口**（只做再导出），实现按「能不能在浏览器里跑」分成三块：
 *
 * - `./routes/internal/request-scope.js` —— 请求面：依赖缝、分页参数、过滤值、数字 id。
 * - `./routes/internal/mint-handler.js` —— 处理器：prefix 匹配、sending（含 DAG 与子代理树
 *   两条按会话寻址的路由）、`installMintRoutes`。
 * - `./routes/internal/cli-surface.js` —— 只读 CLI 面常量（白名单与 meta 三次整表读）。
 * - `./routes/internal/list-policy.js` —— 容器列表策略：结束态白名单、分页重算、argv 拼装。
 *
 * 外部 import 说明符与产物出口都不变（入口仍是 `routes.ts`）。
 */
export { ROUTE_PREFIX } from '../shared/route-paths.js';

export {
  META_LABELS_ARGV,
  META_MILESTONES_ARGV,
  META_PLANS_ARGV,
  READ_ONLY_SUBCOMMANDS,
} from './routes/internal/cli-surface.js';

export {
  BODY_MAX_BYTES,
  DEFAULT_PAGE,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  RouteRequestError,
  parseId,
  parsePageQuery,
  truncateBody,
} from './routes/internal/request-scope.js';
export type {
  ListKind,
  MintRouteDeps,
  MintRunner,
  PageQuery,
} from './routes/internal/request-scope.js';

export {
  CONTAINER_END_STATES,
  buildDetailArgv,
  buildIssueDetailArgv,
  buildListArgv,
  containerListRequest,
  filterValue,
  settledContainerPage,
} from './routes/internal/list-policy.js';
export type { ContainerListRequest, ListPage } from './routes/internal/list-policy.js';

export { createMintHandler, installMintRoutes } from './routes/internal/mint-handler.js';
