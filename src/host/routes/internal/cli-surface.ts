/**
 * 面板路由唯一会跑的 mint 只读面：允许的子命令白名单，以及 meta 路由的三次整表读。
 *
 * 拆出来的判据只有一条——`routes.ts` 撞上 `max-lines` 硬门禁（500 逻辑行，见 `src/AGENTS.md`），
 * 而这一组常量与路由逻辑无关：它们定义的是「面板能对 mint 说什么」，测试也直接断言白名单本身，
 * 而不是断言某条路由的行为。留在同一个文件里只会让门禁与职责互相绑架。
 *
 * 公开面仍是 `routes.ts`：NodeNext 对带 `.js` 扩展的说明符不做目录 index 查找，故
 * 入口必须留成文件，由它同名再导出这几个符号，外部说明符与测试 import 都不变。
 */

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
