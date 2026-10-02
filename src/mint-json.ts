/**
 * Shape guards for the mint CLI's `--json` output.
 *
 * mint is a subprocess, so a `mint-faa` bump can rename a field without any
 * import failing. Every reader therefore validates the fields it renders and
 * reports a warning instead of letting a shrunken list read as real data (#65).
 *
 * Two callers share this module with different appetites: the per-request
 * overview renders a handful of fields (`context.ts` keeps its own minimal
 * predicate), while the client-face routes hand the panel whole records.
 */
import type {
  ContainerDetail,
  IssueDetail,
  IssueItem,
  LabelItem,
  MilestoneItem,
  PlanItem,
} from './records.js';

/** True for a JSON object (not `null`, not an array). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True for a `string`. */
function isString(value: unknown): value is string {
  return typeof value === 'string';
}

/** True for a `number`. */
function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** True for a `number` or an explicit `null` (the CLI's "unset" for foreign keys). */
function isNumberOrNull(value: unknown): value is number | null {
  return value === null || isNumber(value);
}

/**
 * True for a `string` or an explicit `null`.
 *
 * mint serializes most optional columns straight from `Option<String>` /
 * `Option<i64>`, so `null` is a **declared** answer for them, not shape drift:
 * an issue or container without a `body`, a plan whose `version` follows an
 * absent `milestone_id`, a label without a recorded `color` (#94/#95/#96/#108).
 * Requiring a string here dropped those whole records and reported them as
 * "missing required fields".
 */
function isStringOrNull(value: unknown): value is string | null {
  return value === null || isString(value);
}

/** True for an array of strings. */
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

/** A `list --json` issue must carry every field the panel renders. */
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
    Array.isArray(value.links) &&
    isString(value.created_at) &&
    isString(value.updated_at)
  );
}

/** A `plan list --json` record must carry every field the panel renders. */
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

/** A `milestone list --json` record must carry every field the panel renders. */
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

/** A `label list --json` record must carry the color the panel tints with. */
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

/** A `show --json` container must carry the body and the issue list it embeds. */
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
 * `show <id> --json` must carry the list fields plus the body.
 *
 * `list --json` folds an issue's milestone into its plan and omits the body, so
 * the detail read is the only place a panel can see both. An issue created
 * without `--body` answers `"body": null`, which the panel shows as "no body"
 * rather than as an unreadable record (#94).
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

/** Read a CLI pagination counter, falling back to the item list's own size. */
function counter(value: unknown, fallback: number): number {
  return isNumber(value) && value >= 0 ? value : fallback;
}

export interface ParseNoun {
  /** What an unreadable response costs, used in the warning text. */
  noun?: string;
}

/**
 * Parse a `{ items: [...] }` CLI response, validating every item (#65).
 *
 * Mirrors the command-level failure contract: never throws, but never lets a
 * shape mismatch pass as real data either. Items that fail validation are
 * dropped and the caller surfaces a warning, so a renamed field degrades to a
 * visible note rather than a silent empty list.
 *
 * @param source - the command name, quoted back in the warning.
 * @param text - raw stdout.
 * @param isItem - the caller's own appetite for an item.
 * @param options - `noun` names what a failed read costs (default "overview").
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

/** An unreadable list still reports its page shape, so callers need no branch. */
function emptyPage<T>(warning: string): ParsedItems<T> {
  return { items: [], page: 1, pageSize: 0, pages: 1, total: 0, warning };
}

export interface ParsedDetail<T> {
  value?: T;
  warning?: string;
}

/**
 * Parse a single-object `--json` response (`plan show`, `milestone show`).
 *
 * @param source - the command name, quoted back in the warning.
 * @param text - raw stdout.
 * @param isDetail - the caller's validator for the whole object.
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
