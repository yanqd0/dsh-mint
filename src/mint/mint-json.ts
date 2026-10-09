/**
 * mint CLI `--json` 输出的形状守卫。
 *
 * mint 是子进程，所以 `mint-faa` 升级可以悄悄改动字段名而不触发任何 import 失败。因此每个
 * 读者都校验它要渲染的字段，并报出告警，而不是让缩水的列表读成真实数据。
 *
 * 两个调用方以不同胃口共用本模块：每请求概览只渲染少量字段（`context.ts` 留着自己那份最小
 * 谓词），而客户端面路由把整条记录交给面板。
 */
import type {
  ContainerDetail,
  IssueDetail,
  IssueItem,
  LabelItem,
  MilestoneItem,
  PlanItem,
} from '../shared/records.js';

/** 是 JSON 对象（不是 `null`，不是数组）。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** 是 `number` 或显式 `null`（CLI 对外键的「未设置」）。 */
function isNumberOrNull(value: unknown): value is number | null {
  return value === null || isNumber(value);
}

/**
 * 是 `string` 或显式 `null`。
 *
 * mint 多数可选列直接从 `Option<String>` / `Option<i64>` 序列化而来，所以对它们来说 `null`
 * 是**声明过的**答案而非形状漂移：没有 `body` 的 issue/容器、跟在缺失 `milestone_id` 之后的
 * plan `version`、没记 `color` 的 label。以前要求必须是字符串，会把这些整条记录丢掉并报成
 * “missing required fields”。
 */
function isStringOrNull(value: unknown): value is string | null {
  return value === null || isString(value);
}

/** 是 `boolean`。 */
function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

/**
 * **缺失**的可选字段通过校验；一旦出现，就必须满足其声明形状。
 *
 * issue 的 `milestone_id` / `milestone_direct` 自 mint 0.9.0-alpha.1 才有：已发布的
 * `mint-faa`（0.8.1）两个键都不返回，而那是被支持的 CLI，不是坏
 * 掉的 CLI，所以字段缺失必须放行。但字段**存在**时仍要校验类型——`"4"` 或 `"yes"`
 * 是值得告警的重命名，而不是「当作没有 milestone」照常渲染的行。
 *
 * @param value - 解析出来的字段值，CLI 省略时为 `undefined`。
 * @param accepts - 该字段声明类型的校验函数。
 */
function isOptional(value: unknown, accepts: (candidate: unknown) => boolean): boolean {
  return value === undefined || accepts(value);
}

/** 是字符串数组。 */
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

/** 一条 `list --json` issue 必须携带面板渲染的每个字段。 */
export function isIssueItem(value: unknown): value is IssueItem {
  if (!isRecord(value)) return false;
  return (
    isNumber(value.id) &&
    isString(value.title) &&
    isString(value.kind) &&
    isString(value.status) &&
    isNumber(value.priority) &&
    isStringArray(value.labels) &&
    isNumberOrNull(value.plan_id) &&
    // mint 0.9.0-alpha.1 新增：已发布 CLI 不返回，故缺失放行、存在则校验。
    isOptional(value.milestone_id, isNumberOrNull) &&
    isOptional(value.milestone_direct, isBoolean) &&
    Array.isArray(value.links) &&
    isString(value.created_at) &&
    isString(value.updated_at)
  );
}

/** 一条 `plan list --json` 记录必须携带面板渲染的每个字段。 */
export function isPlanItem(value: unknown): value is PlanItem {
  if (!isRecord(value)) return false;
  return (
    isNumber(value.id) &&
    isString(value.title) &&
    isString(value.status) &&
    isStringOrNull(value.version) &&
    isNumberOrNull(value.milestone_id) &&
    isNumber(value.issue_count) &&
    isString(value.created_at) &&
    isString(value.updated_at)
  );
}

/** 一条 `milestone list --json` 记录必须携带面板渲染的每个字段。 */
export function isMilestoneItem(value: unknown): value is MilestoneItem {
  if (!isRecord(value)) return false;
  return (
    isNumber(value.id) &&
    isString(value.title) &&
    isString(value.status) &&
    isStringOrNull(value.version) &&
    isNumber(value.issue_count) &&
    isString(value.created_at) &&
    isString(value.updated_at)
  );
}

/** 一条 `label list --json` 记录必须携带面板用来上色的 color。 */
export function isLabelItem(value: unknown): value is LabelItem {
  if (!isRecord(value)) return false;
  return (
    isNumber(value.id) &&
    isString(value.name) &&
    isStringOrNull(value.color) &&
    (value.description === null || isString(value.description)) &&
    isNumber(value.issue_count) &&
    isString(value.created_at) &&
    isString(value.updated_at)
  );
}

/** 一条 `show --json` 容器必须携带 body 与它内嵌的 issue 列表。 */
export function isContainerDetail(value: unknown): value is ContainerDetail {
  if (!isRecord(value)) return false;
  return (
    isNumber(value.id) &&
    isString(value.title) &&
    isString(value.status) &&
    isStringOrNull(value.version) &&
    isNumberOrNull(value.milestone_id) &&
    isStringOrNull(value.body) &&
    Array.isArray(value.issues) &&
    value.issues.every(
      (issue: unknown) =>
        isRecord(issue) &&
        isNumber(issue.id) &&
        isString(issue.title) &&
        isString(issue.kind) &&
        isString(issue.status)
    ) &&
    isString(value.created_at) &&
    isString(value.updated_at)
  );
}

/**
 * `show <id> --json` 必须携带列表字段加 body。
 *
 * `list --json` 从不带 body，老 CLI 上也不带有效 milestone，所以详情读是面板唯一能确定
 * 同时拿到两者的地方。创建时没给 `--body` 的 issue 会答 `"body": null`，面板显示为「无
 * body」，而不是当成读不出的记录丢掉。
 *
 * `milestone_id` 在这里保持**必到**——与 {@link isIssueItem} 上的可选新字段不同——
 * 因为详情读一直返回它。
 */
export function isIssueDetail(value: unknown): value is IssueDetail {
  if (!isRecord(value)) return false;
  return isIssueItem(value) && isStringOrNull(value.body) && isNumberOrNull(value.milestone_id);
}

export interface ParsedItems<T> {
  items: T[];
  page: number;
  pageSize: number;
  pages: number;
  total: number;
  warning?: string;
}

/** 读一个 CLI 分页计数，缺失时回退到条目列表自身的大小。 */
function counter(value: unknown, fallback: number): number {
  return isNumber(value) && value >= 0 ? value : fallback;
}

export interface ParseNoun {
  /** 读不出来的应答代价是什么，用于告警文本。 */
  noun?: string;
}

/**
 * 解析 `{ items: [...] }` 形式的 CLI 应答，逐条校验。
 *
 * 与命令级失败契约一致：绝不抛，但也绝不让形状不符冒充真实数据。校验不过的条目被丢掉、由
 * 调用方浮出告警，于是被改名的字段降级成一条可见说明，而不是静默的空列表。
 *
 * @param source - 命令名，会在告警里被引用。
 * @param text - 原始 stdout。
 * @param isItem - 调用方自己对一条条目的胃口。
 * @param options - `noun` 命名读失败的代价（默认 "overview"）。
 */
export function parseItems<T>(
  source: string,
  text: string | undefined,
  isItem: (value: unknown) => value is T,
  options: ParseNoun = {}
): ParsedItems<T> {
  const noun = options.noun ?? 'overview';
  let parsed: unknown;
  try {
    parsed = JSON.parse(text ?? '{}');
  } catch {
    return emptyPage(`${source}: response was not JSON — ${noun} unavailable`);
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.items)) {
    return emptyPage(
      `${source}: no "items" array (mint JSON shape changed?) — ${noun} unavailable`
    );
  }
  const items = parsed.items.filter(isItem);
  const warning =
    parsed.items.length - items.length > 0
      ? `${source}: ${parsed.items.length - items.length}/${parsed.items.length} items missing required fields (mint JSON shape changed?) — hidden`
      : undefined;
  const page = counter(parsed.page, 1);
  const pageSize = counter(parsed.page_size, items.length);
  const pages = counter(parsed.pages, 1);
  const total = counter(parsed.total, items.length);
  return warning === undefined
    ? { items, page, pageSize, pages, total }
    : { items, page, pageSize, pages, total, warning };
}

/** 读不出来的列表仍给出页形状，好让调用方不必分支。 */
function emptyPage<T>(warning: string): ParsedItems<T> {
  return { items: [], page: 1, pageSize: 0, pages: 1, total: 0, warning };
}

export interface ParsedDetail<T> {
  value?: T;
  warning?: string;
}

/**
 * 解析单对象的 `--json` 应答（`plan show`、`milestone show`）。
 *
 * @param source - 命令名，会在告警里被引用。
 * @param text - 原始 stdout。
 * @param isDetail - 调用方对整对象的校验器。
 */
export function parseDetail<T>(
  source: string,
  text: string | undefined,
  isDetail: (value: unknown) => value is T
): ParsedDetail<T> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text ?? '{}');
  } catch {
    return { warning: `${source}: response was not JSON — detail unavailable` };
  }
  if (!isDetail(parsed)) {
    return { warning: `${source}: response missing required fields (mint JSON shape changed?)` };
  }
  return { value: parsed };
}
