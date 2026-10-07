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
  /**
   * 该 issue 的「有效 milestone」：自己直挂的优先，否则取所属 plan 的
   * （mint #503 → dsh-mint #90）。
   *
   * **可选是刻意的**：这个字段比多数安装实际解析到的 CLI 新——它随 mint
   * 0.9.0-alpha.1 才有，已发布的 `mint-faa`（0.8.1）根本不返回该键。所以字段缺失
   * 代表「老 CLI」而非形状漂移：读取方退化回经 plan 表解析，绝不因整页 issue 丢了
   * 一个可选字段就全丢。`null` 表示确实没有有效 milestone。
   */
  milestone_id?: number | null;
  /**
   * {@link milestone_id} 是 issue 自己直挂的（`true`）还是经其 plan 得到的
   * （`false`）。可选原因同 {@link milestone_id}：老 CLI 两个键都不返回。
   */
  milestone_direct?: boolean;
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
  /**
   * 这里**始终**有值：`show --json` 早在 list 读也带上它之前就返回了该字段，
   * 这行声明只是把它重新收紧成必到（#90）。
   */
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

/**
 * 面板的字典表：一次读齐，而不是每行读一遍。
 *
 * `list --json` 既不带 label 的颜色、也不带 plan 的版本，所以宿主在这里补齐
 * 这两本字典。issue 归属曾经也在这里拼装（每个 milestone 一次 CLI 调用）；
 * mint 0.9.0-alpha.1 改为把 `milestone_id` / `milestone_direct` 直接写在每个
 * issue 上（mint #503 → dsh-mint #90），故本 payload 只剩字典。
 */
export interface MintMetaPayload {
  ok: true;
  plans: PlanItem[];
  milestones: MilestoneItem[];
  labels: LabelItem[];
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
  /**
   * Epoch ms the host sampled this entry at — present only on a stored sample
   * (a live one carries the answer's `sampled_at`).
   */
  at?: number;
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
