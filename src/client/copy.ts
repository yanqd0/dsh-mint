/**
 * The panel's copy, in one place, in both locales.
 *
 * `ZH` is the key-set source of truth (the repo's Chinese-first convention) and
 * `EN` is checked complete against it at compile time, so no key can exist in
 * one locale only and no key can drift into a different placeholder set.
 * Components only ever call `t()`: `{name}` filling is the locale service's job,
 * and its per-key fallback chain carries a language this dictionary does not
 * cover (say `ja` → `en`) instead of showing a raw key.
 *
 * Two kinds of string read the same in both locales ({@link KEPT_IN_ENGLISH}):
 * the `mint` brand, and the concept names the panel keeps in English. What mint
 * *writes* — status and kind values, `P0`–`P3`, versions, timestamps — stays
 * verbatim in both locales and never travels through this dictionary.
 */

/** This plugin's locale namespace. */
export const NS = 'mint';

/** The translate function a locale namespace binds. */
export type Translate = (key: string, params?: Record<string, string | number>) => string;

/** Simplified Chinese: the key set every other locale is checked against. */
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
  // The host's own measurement; `dag.tokens` above is the fallback for a node
  // whose child the host could not measure, and the marker keeps them apart.
  'dag.liveTokens': '{tokens} tokens（实测）',
  'dag.seconds': '秒',
  'dag.note': '结果原文',
  'dag.node.id': '{id}',
} as const satisfies Record<string, string>;

/** Every key the panel may ask for. A typo is a compile error, not a raw key. */
export type CopyKey = keyof typeof ZH;

/** English: exhaustive over {@link CopyKey}, so a missing key cannot ship. */
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
  'dag.note': 'Result',
  'dag.node.id': '{id}',
} as const satisfies Record<CopyKey, string>;

/**
 * Keys whose two locales are intentionally identical.
 *
 * `mint` is a brand, and `Issue` / `Plan` / `Milestone` are mint's key concepts:
 * the panel names them in English whatever the active locale (the concept words
 * also stay English *inside* the Chinese sentences, e.g. `所属 plan`). The DAG
 * tab adds two more groups: the tab's own name (it *is* the plan's name), and the
 * enumerated values a node carries — `pending` / `running` / `done`, `pass` /
 * `fail`, `research` / `exec` are mint's vocabulary, and a tooltip that renamed
 * them would disagree with the tool the reader just called. The list is asserted
 * in both directions by `copy.test.ts`, so "kept in English" is a checked
 * decision rather than a habit.
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
  // A token count is a unit, not a sentence: `12 tokens` reads the same in both.
  'dag.tokens',
  // A node id is an opaque identifier; nothing about it is language-specific.
  'dag.node.id',
];

/** The panel's translate seat: keys are checked against {@link CopyKey}. */
export type CopyTranslate = (key: CopyKey, params?: Record<string, string | number>) => string;

/**
 * Narrow a namespace-bound translator to the panel's key domain.
 *
 * The seat reads the active locale at call time (the bound function is stable),
 * so a language switch needs no re-registration. Interpolation is the locale
 * service's, and a key no locale carries renders as the key itself: a missing
 * translation is visible rather than silently falling back to Chinese.
 *
 * @param bound - `locale.bind(NS)`, read at call time.
 */
export function createTranslator(bound: Translate): CopyTranslate {
  return (key, params) => bound(key, params);
}
