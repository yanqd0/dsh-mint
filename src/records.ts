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

/** One `plan list --json` record. */
export interface PlanItem {
  id: number;
  title: string;
  status: string;
  version: string;
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
  version: string;
  issue_count: number;
  created_at: string;
  updated_at: string;
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
  version: string;
  milestone_id: number | null;
  body: string;
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

/** `issue get <id> body` — the raw field, truncated at the route's byte budget. */
export interface MintBodyPayload {
  ok: true;
  body: string;
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
