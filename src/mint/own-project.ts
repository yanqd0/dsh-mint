import { projectCacheKey } from './cross-project.js';

/**
 * 会话 cwd 已经解析到的那个项目。
 *
 * 只有当 `-p <项目>` 的 `<项目>` 不等于会话自己目录解析出的项目时，它才是*跨项目*。mint 没有
 * 「我在哪个项目里？」的查询——而本插件不得读 mint 数据库——但每个 `list --json` 条目都携带
 * 解析出的 `project` 名，而概览通道本来就每会话跑一次那个调用。答案记在这里，好让跨项目门禁
 * 与 `mint` 工具无需第二次 spawn 就能比对。
 *
 * 键是 `entry + cwd`，与项目清单备忘一致：不同的 `mintEntry` 对同一目录可以解析出不同项目。
 *
 * **没有 TTL。** cwd → 项目 的映射在会话生命期内稳定，而短到安全的 TTL 会在「每会话一次的
 * 概览」与需要它的工具调用之间过期。`project create` / `project set` *能*改变映射，所以
 * {@link resetOwnProjectCache} 与项目清单重置在同一处调用（`executeMintTool`）。
 *
 * **未知**的名字是真实答案，调用方必须如此对待：门禁继续发问（失败关闭），工具保持安静，所以
 * 缺失的概览绝不会把一次跨项目写变成静默的写。
 */

/** 记住多少个 cwd/entry 对；与其它有界表一致。 */
export const MAX_OWN_PROJECTS = 100;

/** 记住的 cwd/entry → 项目名，按插入顺序（最早在前）。 */
const ownProjects = new Map<string, string>();

/** 记下概览为某个会话目录解析出的项目名。 */
export function noteOwnProject(cwd: string, entry: string | undefined, name: string): void {
  const key = projectCacheKey(cwd, entry);
  // 重新插入，好让更新过的名字也移到最新位置。
  ownProjects.delete(key);
  if (ownProjects.size >= MAX_OWN_PROJECTS) {
    const oldest = ownProjects.keys().next().value;
    if (oldest !== undefined) ownProjects.delete(oldest);
  }
  ownProjects.set(key, name);
}

/**
 * 该目录解析到的项目名；概览还没学到时为 `undefined`。`undefined` 表示「未知」，绝不是
 * 「别的项目」：调用方对它失败关闭。
 */
export function ownProjectOf(cwd: string, entry: string | undefined): string | undefined {
  return ownProjects.get(projectCacheKey(cwd, entry));
}

/** 就我们所知，`project` 是否是本会话自己的项目。 */
export function isOwnProject(cwd: string, entry: string | undefined, project: string): boolean {
  const own = ownProjectOf(cwd, entry);
  return own !== undefined && own === project;
}

/** 忘掉全部已记映射（`project create`/`set`，以及测试）。 */
export function resetOwnProjectCache(): void {
  ownProjects.clear();
}
