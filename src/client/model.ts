/**
 * mint 面板的视图纯逻辑：应答映射、状态配色、标签、链接描述等「要判断」的事都在这里，
 * 因此可以在 Node 里测；React 组件只负责调用并画出结果。
 */
import type {
  ContainerDetail,
  IssueDetail,
  IssueItem,
  MintDetailPayload,
  MintMetaPayload,
  MintResponse,
  PlanItem,
} from '../shared/records.js';
import type { CopyKey, CopyTranslate } from './copy.js';

export type LoadState<T> =
  | { status: 'loading' }
  | { status: 'failed'; message: string; stderr?: string }
  | { status: 'ready'; value: T };

/**
 * 失败也是数据，不是异常：会话已死、mint 入口缺失、CLI 报错都以 `{ ok: false, error }`
 * 抵达，也都渲染成同一个失败态。
 */
export function toLoadState<T extends { ok: true }>(response: MintResponse<T>): LoadState<T> {
  if (response.ok) return { status: 'ready', value: response };
  const { error, stderr } = response;
  return stderr === undefined
    ? { status: 'failed', message: error }
    : { status: 'failed', message: error, stderr };
}

/** 状态徽标可用的主题态 token 色调。 */
export type StatusTone = 'success' | 'warn' | 'idle' | 'error';

export function statusTone(status: string): StatusTone {
  switch (status) {
    case 'done':
      return 'success';
    case 'dropped':
      return 'error';
    case 'dev':
    case 'test':
      return 'warn';
    default:
      return 'idle';
  }
}

export function priorityLabel(priority: number): string {
  return `P${String(priority)}`;
}

export function issueHeadline(item: IssueItem): string {
  return `#${String(item.id)} ${item.title}`;
}

export function hasBody(body: string | null | undefined): body is string {
  return typeof body === 'string' && body.trim().length > 0;
}

/** 已知关系名到 copy key 的映射；不认识的返回 `undefined`。 */
export function linkLabelKey(rel: string): CopyKey | undefined {
  switch (rel) {
    case 'related':
      return 'link.related';
    case 'solves':
      return 'link.solves';
    case 'solved-by':
      return 'link.solved-by';
    case 'duplicates':
      return 'link.duplicates';
    case 'duplicated-by':
      return 'link.duplicated-by';
    case 'blocked_by':
      return 'link.blocked_by';
    case 'blocks':
      return 'link.blocks';
    default:
      return undefined;
  }
}

export interface LinkLine {
  /** 原始关系名；{@link labelKey} 缺失时直接显示它。 */
  rel: string;
  labelKey?: CopyKey;
  /** 被引用的 issue：`#12` 或原始 uid。 */
  target: string;
}

/**
 * 防御式读一条 link 记录：`list --json` 把 links 当作不透明记录发出，面板只需要「什么
 * 关系、指向哪条 issue」，认不出的形状宁可丢掉也不猜。mint 0.8+ 把被引 issue 写作
 * `other_id`（与 `other_title` 相邻，直接序列化自它的 `Link` 结构）；`id`/`uid` 留作
 * 其它应答形状的兜底。
 */
export function describeLink(value: unknown): LinkLine | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const rel = typeof record.rel === 'string' ? record.rel : undefined;
  if (rel === undefined) return undefined;
  const labelKey = linkLabelKey(rel);
  const other = record.other_id ?? record.id;
  const target =
    typeof other === 'number'
      ? `#${String(other)}`
      : typeof record.uid === 'string'
        ? record.uid
        : '';
  return labelKey === undefined ? { rel, target } : { rel, labelKey, target };
}

export function issueMeta(item: IssueItem): string {
  return [priorityLabel(item.priority), item.status].join(' · ');
}

/**
 * 查表之后一条 issue 的归属。
 *
 * 面板要显示它所属的 plan 以及由此推出的 milestone，还必须说清 milestone 是从哪来的：
 * mint 自己的 `--milestone` 过滤语义是「直接挂的，否则取该 issue 的 plan 的」，这个区分
 * 是真实数据，不是展示选择。
 */
export interface PlacementView {
  /** 所属 plan；独立 issue 为 `null`。 */
  planId: number | null;
  /** 生效的 milestone；未知时为 `null`。 */
  milestoneId: number | null;
  milestoneVersion: string | undefined;
  /** true 表示 milestone 来自 issue 自身，而非它的 plan。 */
  direct: boolean;
}

/**
 * milestone id 渲染成的版本号；表里没有就当作「没得显示」——和缺席同义，故 `null` 在这里
 * 收成 `undefined`，各消费方只需一个判断。
 */
export function milestoneVersionOf(
  meta: MintMetaPayload | undefined,
  id: number | null
): string | undefined {
  if (meta === undefined || id === null) return undefined;
  return meta.milestones.find((milestone) => milestone.id === id)?.version ?? undefined;
}

/**
 * 解析一条 issue 行的归属。
 *
 * `list --json` 自 mint 0.9.0-alpha.1 起自己给出生效 milestone 以及它是否 direct，故先
 * 信行本身，`meta` 只用来取面板要印的版本号标签。
 *
 * 两个字段都不带的行走的是旧行为（已发布的 `mint-faa` 0.8.1 仍是受支持的 CLI，不是形状
 * 漂移）：milestone 经该行自己的 `plan_id` 查表，且绝不算作 issue 自身挂的；这种行无
 * 可显示时为 `undefined`。
 *
 * 带了字段的行就被相信，显式的 `null` 也算：`null` 是 mint 的答案而非缺值，plan 表不得
 * 回填一个该行自己否认过的 milestone。
 */
export function issuePlacement(
  item: IssueItem,
  meta: MintMetaPayload | undefined
): PlacementView | undefined {
  const planId = item.plan_id;
  const planMilestone =
    planId === null ? null : (meta?.plans.find((plan) => plan.id === planId)?.milestone_id ?? null);
  const milestoneId = item.milestone_id !== undefined ? item.milestone_id : planMilestone;
  // 没有该标志时，经 plan 得来的 milestone 属于 plan，绝不属于 issue 自身。
  const direct = item.milestone_direct ?? (item.milestone_id != null && item.plan_id === null);
  if (planId === null && milestoneId === null) return undefined;
  return {
    planId,
    milestoneId,
    milestoneVersion: milestoneVersionOf(meta, milestoneId),
    direct,
  };
}

/**
 * 从 `show --json` 解析一条 issue 的归属：明细本身带着生效 milestone，只有版本号标签
 * 需要查表——而「独立 issue 却带 milestone」正是无需任何查表就能判定为 direct 的那一种。
 */
export function detailPlacement(
  item: IssueDetail,
  meta: MintMetaPayload | undefined
): PlacementView | undefined {
  if (item.milestone_id === null && item.plan_id === null) return undefined;
  return {
    planId: item.plan_id,
    milestoneId: item.milestone_id,
    milestoneVersion: milestoneVersionOf(meta, item.milestone_id),
    direct: item.milestone_id !== null && item.plan_id === null,
  };
}

/** 容器行尾部的元信息拼装：空值一律跳过，不留下多余的分隔符。 */
export function containerMeta(parts: readonly (string | number | null | undefined)[]): string {
  return parts
    .filter((part): part is string | number => part !== null && part !== undefined && part !== '')
    .map((part) => String(part))
    .join(' · ');
}

/**
 * 计数所用的 copy key：mint 的计数带单位，英文需要单数形式（`1 issue`）；中文没有复数，
 * 两个 key 在中文里文本相同。
 */
export function countKey(count: number): 'count.issue.one' | 'count.issue.other' {
  return count === 1 ? 'count.issue.one' : 'count.issue.other';
}

/**
 * 面板能用自己的话解释的失败，其 copy key。
 *
 * 宿主答 `{ ok: false, error }`，其中只有稳定的*错误码*归面板翻译；其余都是诊断文本
 * （mint 自己的 stderr、形状告警、畸形请求消息），面板原样显示，好与 CLI 输出比对。
 * `session-not-live` 是用户在面板已开着时唯一会撞上的那个：面板背后的会话结束了。
 */
export function routeErrorKey(message: string): CopyKey | undefined {
  return message === 'session-not-live' ? 'error.sessionNotLive' : undefined;
}

export interface ContainerTarget {
  kind: 'plan' | 'milestone';
  id: number;
}

/**
 * 属于当前渲染 tab 的那个已打开容器。
 *
 * plan id 与 milestone id 是两个命名空间，一种 kind 下打开的 id 绝不能被读成另一种：
 * milestone tab 只认自己这一种，打开的目标属于另一种时就显示列表。
 */
export function activeContainer(
  open: ContainerTarget | undefined,
  kind: 'plan' | 'milestone'
): ContainerTarget | undefined {
  return open !== undefined && open.kind === kind ? open : undefined;
}

export interface ContainerRow {
  id: number;
  title: string;
  meta: string;
}

/** 容器行要的字段；`PlanItem` 与 `MilestoneItem` 都满足它。 */
export interface ContainerRecordLike {
  id: number;
  title: string;
  status: string;
  /** mint 没有时是 `null`；行直接省略这一段。 */
  version: string | null;
  issue_count: number;
}

export function containerRow(item: ContainerRecordLike, copy: CopyTranslate): ContainerRow {
  return {
    id: item.id,
    title: item.title,
    meta: containerMeta([
      item.status,
      item.version,
      copy(countKey(item.issue_count), { count: item.issue_count }),
    ]),
  };
}

/**
 * 从明细 payload 里取出容器：路由会把键填成应答的那种 kind 的名字，这里是唯一需要知道
 * 这层信封的地方。
 */
export function detailContainer(payload: MintDetailPayload<ContainerDetail>): ContainerDetail {
  return 'plan' in payload ? payload.plan : payload.milestone;
}

/**
 * 把页码夹进已加载页的范围内：过滤条件的变化可能在调用方脚下缩小结果集，面板宁可要一个
 * 存在的页，也不要渲染空列表。
 */
export function clampPage(page: number, pages: number): number {
  if (!Number.isFinite(page) || page < 1) return 1;
  const last = Number.isFinite(pages) && pages >= 1 ? pages : 1;
  return Math.min(Math.floor(page), last);
}

/** 内嵌列表一次要多少行；外层列表改用分页。 */
export const EMBEDDED_PAGE_SIZE = 100;

/**
 * 读出一个容器全部关联 issue 的查询。
 *
 * 内嵌列表要显示全部关联项——已结算的状态也算。外层列表默认把它们藏起来，若在这里沿用
 * 那个默认，藏掉的恰恰是 plan/milestone 明细存在的意义。
 */
export function embeddedIssuesQuery(
  kind: 'plan' | 'milestone',
  id: number
): Record<string, string> {
  return {
    [kind]: String(id),
    allStates: '1',
    page: '1',
    pageSize: String(EMBEDDED_PAGE_SIZE),
  };
}

/**
 * 一个 milestone 所辖的 plan。
 *
 * `plan list --milestone` 过滤方式相同，但不额外要求时会排除已结算的 plan，而面板的路由
 * 并不传 `--all-states`：meta 读到的已经是全状态表，故这里由 milestone 明细自行过滤。
 */
export function plansOfMilestone(
  meta: MintMetaPayload | undefined,
  milestoneId: number
): PlanItem[] | undefined {
  if (meta === undefined) return undefined;
  return meta.plans.filter((plan) => plan.milestone_id === milestoneId);
}
