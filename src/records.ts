/**
 * Wire records shared by the host's mint query routes (`src/routes.ts`, #10) and
 * the browser half (`src/client/*`, #11).
 *
 * Types only — nothing here is emitted, so the host bundle and the client bundle
 * agree on one declaration without a runtime edge between them. The field names
 * mirror the mint CLI's own `--json` output (0.9.0-alpha.1), which is what the
 * guards in `src/mint-json.ts` validate.
 */

/** One `list --json` issue record. */
export interface IssueItem {
  id: number;
  title: string;
  kind: string;
  status: string;
  priority: number;
  labels: string[];
  /** Owning plan, or `null` for a standalone issue. */
  plan_id: number | null;
  /** Typed links; each element reaches the panel unvalidated (see `describeLink`). */
  links: unknown[];
  created_at: string;
  updated_at: string;
}

/** One `show <id> --json` issue: everything `list --json` carries, plus the body. */
export interface IssueDetail extends IssueItem {
  /**
   * The issue's markdown body, or `null` when it was created without one (mint
   * serializes the column's `Option`). The route truncates a string at its byte
   * budget; the panel renders both `null` and `''` as "no body" (#94).
   */
  body: string | null;
  /** Always present here, where a list row may fold it into its plan. */
  milestone_id: number | null;
  uid?: string;
  test_cmd?: string | null;
}

/** One `plan list --json` record. */
export interface PlanItem {
  id: number;
  title: string;
  status: string;
  /**
   * The plan's version, which follows its milestone: a plan attached to no
   * milestone answers `null` (#96).
   */
  version: string | null;
  milestone_id: number | null;
  issue_count: number;
  created_at: string;
  updated_at: string;
}

/** One `milestone list --json` record. */
export interface MilestoneItem {
  id: number;
  title: string;
  status: string;
  /** `null` for a milestone created without a version. */
  version: string | null;
  issue_count: number;
  created_at: string;
  updated_at: string;
}

/** One `label list --json` record; the color only exists here, never on an issue. */
export interface LabelItem {
  id: number;
  name: string;
  /** The recorded `#rrggbb` value the panel tints the label's badge with. */
  color: string;
  description: string | null;
  issue_count: number;
  created_at: string;
  updated_at: string;
}

/** Where one issue sits: its effective milestone, and how it got there. */
export interface IssuePlacement {
  /** The milestone the issue effectively belongs to (direct, else its plan's). */
  milestone: number;
  /** True when the milestone is the issue's own, not its plan's. */
  direct: boolean;
}

/**
 * The panel's lookup tables, read once instead of once per row.
 *
 * `list --json` carries neither an issue's effective milestone nor a label's
 * color, so the host assembles both here. `placement` is keyed by issue id as a
 * string, because that is what a JSON object can key by.
 */
export interface MintMetaPayload {
  ok: true;
  plans: PlanItem[];
  milestones: MilestoneItem[];
  labels: LabelItem[];
  placement: Record<string, IssuePlacement>;
  /** Shape-drift and partial-read notices the panel shows instead of guessing. */
  warnings?: string[];
}

/** One issue as a container's `show --json` embeds it. */
export interface ContainerChild {
  id: number;
  title: string;
  kind: string;
  status: string;
}

/** `plan show <id> --json` / `milestone show <id> --json`. */
export interface ContainerDetail {
  id: number;
  title: string;
  status: string;
  /** `null` for a plan whose milestone is absent (the version comes from it). */
  version: string | null;
  milestone_id: number | null;
  /** `null` when the container was created without a body (#95). */
  body: string | null;
  issues: ContainerChild[];
  created_at: string;
  updated_at: string;
}

/** The envelope every `list` route answers with. */
export interface MintListPayload<T> {
  ok: true;
  items: T[];
  page: number;
  page_size: number;
  pages: number;
  total: number;
  /** Shape-drift notices; the panel shows them instead of pretending emptiness is real. */
  warnings?: string[];
}

/** `issue show <id> --json` — the whole issue, with the body the list omits. */
export interface MintIssuePayload {
  ok: true;
  item: IssueDetail;
  /** True when the body hit the route's byte budget. */
  truncated: boolean;
}

/** `plan show` / `milestone show`, discriminated by which key the kind fills. */
export type MintDetailPayload<T> = ({ ok: true } & { plan: T }) | ({ ok: true } & { milestone: T });

/** Any route's refusal: a dead session, a bad parameter, or a mint CLI failure. */
export interface MintFailurePayload {
  ok: false;
  error: string;
  stderr?: string;
}

/** What the panel must handle from any route: a success payload or a refusal. */
export type MintResponse<T extends { ok: true }> = T | MintFailurePayload;
