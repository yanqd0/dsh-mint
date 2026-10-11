/**
 * 面板的全部文案，集中一处、双语并列。
 *
 * `ZH` 是 key 集的真源（本仓中文优先），`EN` 在编译期被检查为对它的穷尽实现，故不会出现
 * 只存在于一侧的 key，也不会出现占位符集合漂移。组件只调 `t()`：`{name}` 填充是 locale
 * 服务的活，它按 key 逐级回退，可以把本字典没有的语言（比如 `ja` → `en`）接住，而不是
 * 渲染出原始 key。
 *
 * 有两类字符串在两侧读起来一样（见 {@link KEPT_IN_ENGLISH}）：`mint` 这个品牌，以及面板
 * 保留英文的概念名。mint *写出来*的东西——状态与 kind 取值、`P0`–`P3`、版本号、时间戳
 * ——两侧都原样显示，从不经过本字典。
 */

export const NS = 'mint';

/** locale 命名空间绑定的翻译函数。 */
export type Translate = (key: string, params?: Record<string, string | number>) => string;

/** 简体中文：其它 locale 的 key 集都以它为准。 */
export const ZH = {
  'type.label': 'mint',
  'guide.title': 'mint 面板',
  'guide.description': '浏览本项目的 issue、plan 与 milestone',

  'view.issues': 'Issue',
  'view.plans': 'Plan',
  'view.milestones': 'Milestone',

  'panel.refresh': '刷新',
  'panel.search': '搜索',
  'panel.allStates': '含已结束',
  'panel.truncated': '正文过长，已截断',
  'panel.embeddedLimited': '仅显示前 {shown} 条',
  'panel.metaUnavailable': '归属与标签颜色暂不可用，刷新重试',

  'state.loading': '加载中…',
  'state.empty': '暂无数据',
  'state.error': '加载失败',
  'state.retry': '重试',

  'error.sessionNotLive': '会话已结束，请切换会话后重试',

  'detail.back': '返回',
  'detail.body': '正文',
  'detail.noBody': '（无正文）',
  'detail.kind': '类型 {kind}',
  'detail.priority': '优先级 {priority}',
  'detail.created': '创建于 {at}',
  'detail.updated': '更新于 {at}',
  'detail.version': '版本 {version}',
  'detail.milestone': '所属 milestone #{id}',
  'detail.plans': '包含 plan',
  'detail.issues': '包含 issue',
  'detail.standalone': '未挂 plan',

  'placement.plan': '所属 plan',
  'placement.milestone': '所属 milestone',
  'placement.milestoneViaPlan': '所属 milestone（经 plan 关联）',

  'container.plan': 'Plan',
  'container.milestone': 'Milestone',

  'body.copy': '复制',
  'body.copied': '已复制',
  // 正文区两个模式的名称与切换控件的无障碍名；`footnotes` 是渲染出的脚注小节标题。
  'body.mode.preview': '预览',
  'body.mode.code': '代码',
  'body.mode.label': '正文显示方式',
  'body.footnotes': '脚注',

  'link.related': '相关',
  'link.solves': '解决',
  'link.solved-by': '被解决',
  'link.duplicates': '重复',
  'link.duplicated-by': '被重复',
  'link.blocked_by': '阻塞于',
  'link.blocks': '阻塞',

  'pager.summary': '第 {page}/{pages} 页，共 {total} 条',
  'pager.prev': '上一页',
  'pager.next': '下一页',

  'count.issue.one': '{count} 个 issue',
  'count.issue.other': '{count} 个 issue',

  'dag.type.label': 'Plan DAG',
  'dag.guide.title': 'Plan DAG',
  'dag.guide.description': '查看本会话 plan 的节点与依赖',
  'dag.empty': '本会话暂无 DAG',
  'dag.unreadable': 'DAG 不可读',
  'dag.file': '文件 {path}',
  'dag.count': '{nodes} 个节点，{edges} 条边',
  'dag.runningCount': '{count} 个 running',
  'dag.status.pending': 'pending',
  'dag.status.running': 'running',
  'dag.status.done': 'done',
  'dag.verdict.pass': 'pass',
  'dag.verdict.fail': 'fail',
  'dag.phase.research': 'research',
  'dag.phase.exec': 'exec',
  'dag.tokens': '{tokens} tokens',
  // 宿主自己实测出来的值；上面的 `dag.tokens` 是宿主测不到子代理时的退路，标记用来
  // 把两者区分开。
  'dag.liveTokens': '{tokens} tokens（实测）',
  'dag.seconds': '秒',
  // `at` 是本地钟点、由调用方格式化：这里翻译的是标签，永远不是时间戳。
  'dag.measuredAt': '实测于 {at}',
  // 实测的成本构成：四桶分开落，因为命中与未命中的单价相差约 50 倍——`tokens` 只是
  // 它们的和，不是成本代理。步数补上「为什么这么大」：步数 × 留存上下文主导成本。
  'dag.bucket.uncachedInput': '未命中',
  'dag.bucket.cacheRead': '命中',
  'dag.bucket.cacheWrite': '缓存写',
  'dag.bucket.output': '输出',
  'dag.steps': '{steps} 步',
  'dag.note': '结果原文',
  // 节点独立的工作树：它所在的分支，以及该工作区的状态。四种状态是 mint 自己的词汇，
  // 故两侧读起来一样（见 `KEPT_IN_ENGLISH`）。
  'dag.worktree.branch': '分支 {branch}',
  'dag.worktree.state.active': 'active',
  'dag.worktree.state.merged': 'merged',
  'dag.worktree.state.conflict': 'conflict',
  'dag.worktree.state.removed': 'removed',
  'dag.node.id': '{id}',
} as const satisfies Record<string, string>;

/** 面板可以请求的全部 key：拼错是编译错误，而不是渲染成一个原始 key。 */
export type CopyKey = keyof typeof ZH;

/** 英语：对 {@link CopyKey} 穷尽，故漏掉一个 key 就发不出去。 */
export const EN = {
  'type.label': 'mint',
  'guide.title': 'mint panel',
  'guide.description': "Browse this project's issues, plans and milestones",

  'view.issues': 'Issue',
  'view.plans': 'Plan',
  'view.milestones': 'Milestone',

  'panel.refresh': 'Refresh',
  'panel.search': 'Search',
  'panel.allStates': 'Include ended',
  'panel.truncated': 'Body truncated',
  'panel.embeddedLimited': 'Showing the first {shown}',
  'panel.metaUnavailable': 'Placement and label colors unavailable; refresh to retry',

  'state.loading': 'Loading…',
  'state.empty': 'No data',
  'state.error': 'Failed to load',
  'state.retry': 'Retry',

  'error.sessionNotLive': 'This session ended; switch sessions and try again',

  'detail.back': 'Back',
  'detail.body': 'Body',
  'detail.noBody': '(no body)',
  'detail.kind': 'Kind {kind}',
  'detail.priority': 'Priority {priority}',
  'detail.created': 'Created {at}',
  'detail.updated': 'Updated {at}',
  'detail.version': 'Version {version}',
  'detail.milestone': 'Milestone #{id}',
  'detail.plans': 'Plans',
  'detail.issues': 'Issues',
  'detail.standalone': 'No plan',

  'placement.plan': 'Plan',
  'placement.milestone': 'Milestone',
  'placement.milestoneViaPlan': 'Milestone (via its plan)',

  'container.plan': 'Plan',
  'container.milestone': 'Milestone',

  'body.copy': 'Copy',
  'body.copied': 'Copied',
  'body.mode.preview': 'Preview',
  'body.mode.code': 'Code',
  'body.mode.label': 'Body display',
  'body.footnotes': 'Footnotes',

  'link.related': 'Related',
  'link.solves': 'Solves',
  'link.solved-by': 'Solved by',
  'link.duplicates': 'Duplicates',
  'link.duplicated-by': 'Duplicated by',
  'link.blocked_by': 'Blocked by',
  'link.blocks': 'Blocks',

  'pager.summary': 'Page {page} of {pages} · {total} total',
  'pager.prev': 'Previous',
  'pager.next': 'Next',

  'count.issue.one': '{count} issue',
  'count.issue.other': '{count} issues',

  'dag.type.label': 'Plan DAG',
  'dag.guide.title': 'Plan DAG',
  'dag.guide.description': "This session's plan DAG: nodes and dependencies",
  'dag.empty': 'No DAG in this session',
  'dag.unreadable': 'DAG is unreadable',
  'dag.file': 'File {path}',
  'dag.count': '{nodes} nodes, {edges} edges',
  'dag.runningCount': '{count} running',
  'dag.status.pending': 'pending',
  'dag.status.running': 'running',
  'dag.status.done': 'done',
  'dag.verdict.pass': 'pass',
  'dag.verdict.fail': 'fail',
  'dag.phase.research': 'research',
  'dag.phase.exec': 'exec',
  'dag.tokens': '{tokens} tokens',
  'dag.liveTokens': '{tokens} tokens (measured)',
  'dag.seconds': 's',
  'dag.measuredAt': 'measured {at}',
  'dag.bucket.uncachedInput': 'cache miss',
  'dag.bucket.cacheRead': 'cache hit',
  'dag.bucket.cacheWrite': 'cache write',
  'dag.bucket.output': 'output',
  'dag.steps': '{steps} steps',
  'dag.note': 'Result',
  'dag.worktree.branch': 'Branch {branch}',
  'dag.worktree.state.active': 'active',
  'dag.worktree.state.merged': 'merged',
  'dag.worktree.state.conflict': 'conflict',
  'dag.worktree.state.removed': 'removed',
  'dag.node.id': '{id}',
} as const satisfies Record<CopyKey, string>;

/**
 * 两种 locale 有意取同一文本的 key。
 *
 * `mint` 是品牌，`Issue` / `Plan` / `Milestone` 是 mint 的核心概念：无论当前是哪种
 * locale，面板都用英文称呼它们（这些概念词在中文句子里也照样是英文，例如 `所属 plan`）。
 * DAG tab 又添了两组：tab 自己的名字（它就是 plan 的名字），以及节点携带的枚举值——
 * `pending` / `running` / `done`、`pass` / `fail`、`research` / `exec` 都是 mint 的
 * 词汇，改名的 tooltip 会与读者刚调用过的工具对不上；worktree 状态
 * （`active` / `merged` / `conflict` / `removed`）出于同样理由入列。`copy.test.ts` 双向
 * 断言这份名单，所以「保留英文」是被检查过的决定，而不是随手。
 */
export const KEPT_IN_ENGLISH: readonly CopyKey[] = [
  'type.label',
  'view.issues',
  'view.plans',
  'view.milestones',
  'container.plan',
  'container.milestone',
  'dag.type.label',
  'dag.guide.title',
  'dag.status.pending',
  'dag.status.running',
  'dag.status.done',
  'dag.verdict.pass',
  'dag.verdict.fail',
  'dag.phase.research',
  'dag.phase.exec',
  'dag.worktree.state.active',
  'dag.worktree.state.merged',
  'dag.worktree.state.conflict',
  'dag.worktree.state.removed',
  // 令牌数是一个单位而非句子：`12 tokens` 两侧读起来一样。
  'dag.tokens',
  // 节点 id 是不透明标识符，没有任何语言相关的部分。
  'dag.node.id',
];

/** 面板的翻译座位：key 按 {@link CopyKey} 检查。 */
export type CopyTranslate = (key: CopyKey, params?: Record<string, string | number>) => string;

/**
 * 把命名空间绑定的翻译器收窄到面板的 key 域。
 *
 * 这个座位在调用时才读当前 locale（绑定的函数是稳定的），所以切换语言无需重新注册。
 * 插值交给 locale 服务；任何 locale 都没有的 key 渲染成 key 本身——缺翻译要看得见，
 * 而不是悄悄回退到中文。
 */
export function createTranslator(bound: Translate): CopyTranslate {
  return (key, params) => bound(key, params);
}
