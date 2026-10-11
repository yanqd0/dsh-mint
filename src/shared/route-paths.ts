/**
 * 面板的路由空间，插件两侧共读：宿主在 `ctx.webServer` 上注册前缀、在前缀内按名匹配
 * （`src/routes.ts`），浏览器半边拼同样的路径去 fetch（`src/client/api.ts`）——一份声明，
 * 改名只需一处。
 *
 * 只放纯数据与纯函数：客户端 bundle 会内联本模块，绝不能碰 node 内置模块。
 */

/**
 * 所有路由都挂在这个前缀下，一次注册独占整个空间。
 *
 * **不带尾斜杠**：宿主按 `pathname === prefix || pathname.startsWith(prefix + '/')` 匹配，
 * 注册成 `/dsh-mint/` 就只匹配 `/dsh-mint/` 或 `/dsh-mint//…`，`/dsh-mint/issues` 会落到
 * SPA fallback、变成空 404。
 */
export const ROUTE_PREFIX = '/dsh-mint';

/** 前缀下的路由名，按宿主路由表的顺序。 */
export const ROUTE_NAMES = [
  'issues',
  'plans',
  'milestones',
  'issue',
  'plan',
  'milestone',
  'meta',
  // The plan DAG's read-only view: file-keyed rather than
  // project-keyed, so it takes a session id and spawns no CLI.
  'dag',
  // The subagent tree of the same session: read entirely off live host
  // services, so it also takes a session id and spawns no CLI.
  'agents',
] as const;

export type RouteName = (typeof ROUTE_NAMES)[number];

export function routePath(name: RouteName): string {
  return `${ROUTE_PREFIX}/${name}`;
}

export function isRouteName(name: string): name is RouteName {
  return (ROUTE_NAMES as readonly string[]).includes(name);
}
