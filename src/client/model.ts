/**
 * Pure view logic for the mint panel.
 *
 * Everything a view needs to *decide* lives here — response mapping, status
 * coloring, labels, link description — so it can be tested in Node. The React
 * components stay presentational: they call these and draw the result.
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

/** The one-line headline of an issue row, without decoration. */
export function issueHeadline(item: IssueItem): string {
  return `#${String(item.id)} ${item.title}`;
}

/** True when a body has anything to show; mint bodies are often empty or `null`. */
export function hasBody(body: string | null | undefined): body is string {
  return typeof body === 'string' && body.trim().length > 0;
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
 * rather than guessed at. mint 0.8+ names the cited issue `other_id` (serialized
 * straight from its `Link` struct, next to `other_title`); `id`/`uid` stay as
 * fallbacks for other answer shapes (#97).
 *
 * @param value - one element of `IssueItem.links`.
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
  return labelKey === undefined
    ? { rel, target }
    : { rel, labelKey, target };
}

/** Where an issue sits, as one short string: `P1 · dev`. */
export function issueMeta(item: IssueItem): string {
  return [priorityLabel(item.priority), item.status].join(' · ');
}

/**
 * Where one issue sits, once the lookup tables have answered.
 *
 * The panel shows the plan it belongs to and the milestone that follows from it,
 * and it must say which of the two a milestone came from: mint's own
 * `--milestone` filter means "direct, else the issue's plan's", so the
 * distinction is real data, not a presentation choice.
 */
export interface PlacementView {
  /** Owning plan, or `null` for a standalone issue. */
  planId: number | null;
  /** Effective milestone, when one is known. */
  milestoneId: number | null;
  /** The milestone's version, the label the panel shows for it. */
  milestoneVersion: string | undefined;
  /** True when the milestone is the issue's own rather than its plan's. */
  direct: boolean;
}

/**
 * The version a milestone id renders as; `undefined` when the table lacks it.
 *
 * A milestone answered without a version is the same "nothing to show" as an
 * absent one, so `null` collapses into `undefined` here and every row/detail
 * consumer keeps its single existing check (#96).
 */
export function milestoneVersionOf(
  meta: MintMetaPayload | undefined,
  id: number | null
): string | undefined {
  if (meta === undefined || id === null) return undefined;
  return meta.milestones.find((milestone) => milestone.id === id)?.version ?? undefined;
}

/**
 * Resolve an issue row's placement.
 *
 * `list --json` now states the issue's effective milestone itself and whether it
 * is direct (mint 0.9.0-alpha.1, mint #503 → dsh-mint #90), so the row is
 * believed first and `meta` only supplies the version label the panel prints.
 *
 * A row that carries **neither** field predates them (the published `mint-faa`
 * 0.8.1 is a supported CLI, not shape drift), so the old behaviour applies: the
 * milestone is looked up through the row's own `plan_id`, and that milestone
 * never counts as the issue's own. `undefined` means the row has nothing to show.
 *
 * A row that **does** carry the field is believed, explicit `null` included:
 * `null` is mint's own answer, not a missing value, so the plan table must not
 * back-fill a milestone the row itself denied.
 *
 * @param item - one `list --json` issue.
 * @param meta - the lookup tables, or `undefined` when they are not loaded.
 */
export function issuePlacement(
  item: IssueItem,
  meta: MintMetaPayload | undefined
): PlacementView | undefined {
  const planId = item.plan_id;
  // The row is believed whenever it carries the field — explicit `null` included,
  // because `null` is mint's answer rather than a missing one. The plan table is
  // only the fallback for a row that predates the field, and it is also (with
  // `meta.milestones`) where the version label the panel prints comes from.
  const planMilestone =
    planId === null ? null : (meta?.plans.find((plan) => plan.id === planId)?.milestone_id ?? null);
  const milestoneId = item.milestone_id !== undefined ? item.milestone_id : planMilestone;
  // Without the flag, a milestone that came through the plan belongs to the plan,
  // never to the issue itself.
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
 * Resolve one issue's placement from `show --json`.
 *
 * The detail read carries the effective milestone itself, so only its version
 * label needs the table — and a standalone issue with a milestone is the one
 * case the panel can call direct without any lookup at all.
 *
 * @param item - the issue `show --json` returned.
 * @param meta - the lookup tables, or `undefined` when they are not loaded.
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

/** One container row's trailing meta: `open · 0.2.0 · 6 issues`. */
export function containerMeta(parts: readonly (string | number | null | undefined)[]): string {
  return parts
    .filter((part): part is string | number => part !== null && part !== undefined && part !== '')
    .map((part) => String(part))
    .join(' · ');
}

/**
 * The copy key for a count: mint counts are written with their unit, and English
 * needs the singular form (`1 issue`). Chinese has no plural, so both keys carry
 * the same text there.
 *
 * @param count - how many issues the line stands for.
 */
export function countKey(count: number): 'count.issue.one' | 'count.issue.other' {
  return count === 1 ? 'count.issue.one' : 'count.issue.other';
}

/**
 * The copy key for a route failure the panel can explain in its own words.
 *
 * The host answers `{ ok: false, error }`, and only a stable *code* is the
 * panel's to translate; everything else is diagnostic text — mint's own stderr,
 * a shape warning, a malformed-request message — which the panel shows verbatim
 * so it can be compared with the CLI. `session-not-live` is the one a user
 * reaches with a panel already open: the session behind it ended.
 *
 * @param message - the failure text as the route sent it.
 */
export function routeErrorKey(message: string): CopyKey | undefined {
  return message === 'session-not-live' ? 'error.sessionNotLive' : undefined;
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
  /** `null` when mint has none for this container; the row simply omits it. */
  version: string | null;
  issue_count: number;
}

/** Project a plan or milestone record onto a list row. */
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

/** How many rows an embedded list asks for; the outer lists page instead. */
export const EMBEDDED_PAGE_SIZE = 100;

/**
 * The query that reads everything one container holds.
 *
 * An embedded list shows every associated issue — settled states included. The
 * outer list hides them by default, and reusing that default here would hide
 * exactly the history a plan or milestone detail exists to show.
 *
 * @param kind - which container's issues to read.
 * @param id - that container's id.
 */
export function embeddedIssuesQuery(kind: 'plan' | 'milestone', id: number): Record<string, string> {
  return {
    [kind]: String(id),
    allStates: '1',
    page: '1',
    pageSize: String(EMBEDDED_PAGE_SIZE),
  };
}

/**
 * The plans one milestone holds.
 *
 * `plan list --milestone` filters the same way, but excludes settled plans unless
 * asked, and the panel's route does not pass `--all-states`: the meta read is
 * already the all-states table, so the milestone detail filters it here.
 *
 * @param meta - the lookup tables, or `undefined` when they are not loaded.
 * @param milestoneId - the milestone whose plans to list.
 * @returns the plans, or `undefined` when the table is missing.
 */
export function plansOfMilestone(
  meta: MintMetaPayload | undefined,
  milestoneId: number
): PlanItem[] | undefined {
  if (meta === undefined) return undefined;
  return meta.plans.filter((plan) => plan.milestone_id === milestoneId);
}
