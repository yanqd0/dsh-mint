/**
 * The panel's copy, in one place.
 *
 * 0.2.0 ships Simplified Chinese only, but every string still travels through
 * the client `locale` service: the dictionary is registered under both built-in
 * locale ids (`en` temporarily points at the Chinese text so an English-locale
 * page shows words instead of raw keys), and components only ever call `t()`.
 * 0.3.0 therefore replaces data, not code.
 */

/** This plugin's locale namespace. */
export const NS = 'mint';

/** The translate function a locale namespace binds. */
export type Translate = (key: string, params?: Record<string, string | number>) => string;

const COPY = {
  'type.label': 'Mint',
  'guide.title': 'Mint 面板',
  'guide.description': '查看本项目的 issue、plan 与 milestone',

  'view.issues': 'Issue',
  'view.plans': 'Plan',
  'view.milestones': 'Milestone',

  'panel.refresh': '刷新',
  'panel.search': '搜索',
  'panel.allStates': '含已关闭',
  'panel.truncated': '正文过长，已截断',

  'state.loading': '加载中…',
  'state.empty': '暂无数据',
  'state.error': '加载失败',
  'state.retry': '重试',
  'state.sessionGone': '当前会话不可用，请切换会话后重试',
  'state.skeleton': '列表与详情将在后续版本接入。',

  'field.kind': '类型',
  'field.status': '状态',
  'field.priority': '优先级',
  'field.labels': '标签',
  'field.plan': '所属 plan',
  'field.milestone': '所属 milestone',
  'field.version': '版本',
  'field.created': '创建',
  'field.updated': '更新',
  'field.issues': '包含 issue',

  'detail.back': '返回',
  'detail.body': '正文',
  'detail.standalone': '未挂 plan',

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
} as const;

/** Every key the panel may ask for. A typo is a compile error, not a raw key. */
export type CopyKey = keyof typeof COPY;

/** The dictionary as registered: one entry per key, Simplified Chinese. */
export const ZH: Readonly<Record<CopyKey, string>> = COPY;

/** The panel's translate seat: keys are checked against {@link ZH}. */
export type CopyTranslate = (key: CopyKey, params?: Record<string, string | number>) => string;

/** Fill `{name}` placeholders; an unknown name is left as written. */
export function interpolate(text: string, params?: Record<string, string | number>): string {
  if (params === undefined) return text;
  return text.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}

/**
 * Wrap a namespace-bound translator so a key the active locale does not carry
 * still renders Chinese instead of the key itself.
 *
 * @param bound - `locale.bind(NS)`, read at call time so a language switch is
 *   picked up without re-registering anything.
 */
export function createTranslator(bound: Translate): CopyTranslate {
  return (key, params) => {
    const text = bound(key, params);
    return text === key ? interpolate(ZH[key], params) : text;
  };
}
