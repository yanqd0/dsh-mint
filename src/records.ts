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
  /**
   * The recorded `#rrggbb` value the panel tints the label's badge with, or
   * `null` for a label mint has no color for — the panel falls back to a neutral
   * chip instead of losing the label (#108).
   */
  color: string | null;
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

/**
 * The plan DAG's wire records (plan #31).
 *
 * One declaration for the host's `/dsh-mint/dag` route and the browser half that
 * renders it: the document lives in `/tmp/mint/dag/<sessionId>.json`, and the
 * panel is a pure function of what this route answers. The host-side document
 * (`src/dag.ts`) adds its own ownership fields on top of {@link DagView}.
 */

/** Which half of a plan the node belongs to. */
export type DagPhase = 'research' | 'exec';

/** A node's lifecycle: not started, in flight, settled. */
export type DagStatus = 'pending' | 'running' | 'done';

/**
 * A settled node's outcome — success or a refuted direction.
 *
 * Only meaningful with `status: 'done'`: the host refuses a verdict on a
 * non-terminal node, so the panel can read the two fields without guessing.
 */
export type DagVerdict = 'pass' | 'fail';

/** One node of the plan DAG, as the panel renders it. */
export interface DagNodeView {
  id: string;
  /** Short label drawn inside the node (≤6 code points, enforced by the host). */
  label: string;
  /** Full title, shown in the hover tooltip. */
  title: string;
  phase: DagPhase;
  status: DagStatus;
  /** Present only for a settled node. */
  verdict?: DagVerdict;
  /** Predecessors: the nodes this one waits for. */
  depends_on: string[];
  /** mint issue this node tracks, when it tracks one. */
  issue?: number;
  /** Subagent session id, backfilled by the host's `subagent/start` pairing. */
  agent?: string;
  /** Self-reported token count; the host has no query for a child's usage. */
  tokens?: number;
  /** The conclusion text a node's own agent reported (tooltip, scrollable). */
  note?: string;
  updated_at: string;
}

/** One node's host-measured usage, absent when the host cannot read it (never a zero guess). */
export interface DagNodeMetrics {
  /** The child session's four durable token buckets, summed. */
  tokens?: number;
  /** Active-turn duration in milliseconds, from the host's own timing projection. */
  elapsed_ms?: number;
}

/**
 * One plan DAG as the route publishes it.
 *
 * `edges` are `[from, to]` pairs meaning **`to` depends on `from`** — the same
 * direction as {@link DagNodeView.depends_on}.
 */
export interface DagView {
  title: string;
  /** Increments on every write; the panel re-renders only when it changes. */
  revision: number;
  created_at: string;
  updated_at: string;
  nodes: DagNodeView[];
  edges: [string, string][];
}

/**
 * `GET /dsh-mint/dag` — the panel's whole view.
 *
 * A missing file is the normal "no DAG in this session" state (`dag: null`,
 * no warnings); an unreadable one is the same empty `dag` plus a `warnings`
 * entry, so the panel can name the file it could not read instead of going
 * blank.
 */
export interface MintDagPayload {
  ok: true;
  dag: DagView | null;
  /** The answered revision (`0` when there is no readable DAG). */
  revision: number;
  /** Absolute path the answer came from; shown in the empty/unreadable states. */
  file: string;
  /** Mount-line `openDagTab`: whether the client should auto-open the panel. */
  autoOpen: boolean;
  /** Per-node live metrics, keyed by node id; absent when the host read nothing. */
  metrics?: Record<string, DagNodeMetrics>;
  /** The host clock (epoch ms) every metric in this answer was sampled at. */
  sampled_at?: number;
  warnings?: string[];
}
