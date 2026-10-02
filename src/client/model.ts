/**
 * Pure view logic for the mint panel.
 *
 * Everything a view needs to *decide* lives here — response mapping, status
 * coloring, labels, link description — so it can be tested in Node. The React
 * components stay presentational: they call these and draw the result.
 */
import type {
  ContainerChild,
  ContainerDetail,
  IssueItem,
  MintDetailPayload,
  MintResponse,
} from '../records.js';
import type { CopyKey } from './copy.js';

/** What a view knows about one request. */
export type LoadState<T> =
  | { status: 'loading' }
  | { status: 'failed'; message: string; stderr?: string }
  | { status: 'ready'; value: T };

/**
 * Map a route response onto view state.
 *
 * A failure is data, not an exception: a dead session, a missing mint entry, and
 * a CLI error all arrive as `{ ok: false, error }` and all render the same way.
 */
export function toLoadState<T extends { ok: true }>(response: MintResponse<T>): LoadState<T> {
  if (response.ok) return { status: 'ready', value: response };
  const { error, stderr } = response;
  return stderr === undefined
    ? { status: 'failed', message: error }
    : { status: 'failed', message: error, stderr };
}

/** The tone a status pill takes, mapped onto theme state tokens. */
export type StatusTone = 'success' | 'warn' | 'idle' | 'error';

/** mint's lifecycle states: done is settled, dev/test are in flight, the rest idle. */
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

/** Render a priority as mint writes it: `P0` is the most urgent. */
export function priorityLabel(priority: number): string {
  return `P${String(priority)}`;
}

/**
 * Join labels for a one-line summary.
 *
 * @param labels - the issue's labels, in CLI order.
 * @param max - how many to show before eliding; the count makes the elision honest.
 */
export function labelSummary(labels: readonly string[], max = 3): string | undefined {
  if (labels.length === 0) return undefined;
  const shown = labels.slice(0, max).join(' · ');
  const hidden = labels.length - max;
  return hidden > 0 ? `${shown} +${String(hidden)}` : shown;
}

/** The one-line headline of an issue row, without decoration. */
export function issueHeadline(item: IssueItem): string {
  return `#${String(item.id)} ${item.title}`;
}

/** The copy key for a mint link relation, when the panel knows it. */
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

/** One link as the panel shows it. */
export interface LinkLine {
  /** The raw relation, shown when {@link labelKey} is absent. */
  rel: string;
  labelKey?: CopyKey;
  /** The cited issue, as `#12` or the raw uid. */
  target: string;
}

/**
 * Read one link record defensively.
 *
 * `list --json` carries links as opaque records and the panel only ever needs
 * "what relation, to which issue"; a shape this does not recognize is dropped
 * rather than guessed at.
 *
 * @param value - one element of `IssueItem.links`.
 */
export function describeLink(value: unknown): LinkLine | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const rel = typeof record.rel === 'string' ? record.rel : undefined;
  if (rel === undefined) return undefined;
  const labelKey = linkLabelKey(rel);
  const target =
    typeof record.id === 'number'
      ? `#${String(record.id)}`
      : typeof record.uid === 'string'
        ? record.uid
        : '';
  return labelKey === undefined
    ? { rel, target }
    : { rel, labelKey, target };
}

/** Where an issue sits, as one short string: `P1 · dev · #3`. */
export function issueMeta(item: IssueItem): string {
  return [
    priorityLabel(item.priority),
    item.status,
    item.plan_id === null ? undefined : `#${String(item.plan_id)}`,
  ]
    .filter((part): part is string => part !== undefined)
    .join(' · ');
}

/** One issue a container lists, as a single line. */
export function containerChildLine(child: ContainerChild): string {
  return `#${String(child.id)} [${child.kind}] ${child.title}`;
}

/** One container row's trailing meta: `open · 0.2.0 · 6`. */
export function containerMeta(parts: readonly (string | number | null | undefined)[]): string {
  return parts
    .filter((part): part is string | number => part !== null && part !== undefined && part !== '')
    .map((part) => String(part))
    .join(' · ');
}

/** Which container a detail view is showing: the kind is part of the target. */
export interface ContainerTarget {
  kind: 'plan' | 'milestone';
  id: number;
}

/**
 * The open container that belongs to the tab being rendered.
 *
 * Plan ids and milestone ids are different namespaces, so an id opened under one
 * kind must never be read as the other (#82): a milestone tab asks for its own
 * kind and shows its list when the open target belongs to the other one.
 */
export function activeContainer(
  open: ContainerTarget | undefined,
  kind: 'plan' | 'milestone'
): ContainerTarget | undefined {
  return open !== undefined && open.kind === kind ? open : undefined;
}

/** One row of the plan or milestone list. */
export interface ContainerRow {
  id: number;
  title: string;
  /** Status, version, and how many issues it holds. */
  meta: string;
}

/** The fields a container row shows; both `PlanItem` and `MilestoneItem` satisfy it. */
export interface ContainerRecordLike {
  id: number;
  title: string;
  status: string;
  version: string;
  issue_count: number;
}

/** Project a plan or milestone record onto a list row. */
export function containerRow(item: ContainerRecordLike): ContainerRow {
  return {
    id: item.id,
    title: item.title,
    meta: containerMeta([item.status, item.version, `${String(item.issue_count)} issues`]),
  };
}

/**
 * Read the container out of a detail payload.
 *
 * The route fills whichever key names the kind that answered, so this is the one
 * place that has to know about that envelope.
 *
 * @param payload - `plan show --json` or `milestone show --json`.
 */
export function detailContainer(payload: MintDetailPayload<ContainerDetail>): ContainerDetail {
  return 'plan' in payload ? payload.plan : payload.milestone;
}

/**
 * Clamp a page number into a loaded page's range.
 *
 * A filter change can shrink the result set under the caller's feet; the panel
 * asks for a page that exists instead of rendering an empty list.
 */
export function clampPage(page: number, pages: number): number {
  if (!Number.isFinite(page) || page < 1) return 1;
  const last = Number.isFinite(pages) && pages >= 1 ? pages : 1;
  return Math.min(Math.floor(page), last);
}
