/**
 * The panel's transport: `fetch` against the host's read-only `/dsh-mint/` routes
 * (#10).
 *
 * Paths resolve against `document.baseURI` rather than the origin — the page can
 * be mounted under a prefix (reverse proxy, multiple deployments behind one
 * host), and a root-absolute path would miss that prefix and 404. Every failure
 * comes back as `{ ok: false, error }` rather than a throw, so the panel renders
 * one error state for a dead session, a broken mint entry, and a CLI failure
 * alike.
 */
import type {
  ContainerDetail,
  IssueItem,
  MilestoneItem,
  MintBodyPayload,
  MintDetailPayload,
  MintFailurePayload,
  MintListPayload,
  MintResponse,
  PlanItem,
} from '../records.js';
import type { MintApiLike } from './types.js';

/** One route's path, relative to the served page. */
const ROUTES = {
  issues: '/dsh-mint/issues',
  plans: '/dsh-mint/plans',
  milestones: '/dsh-mint/milestones',
  issue: '/dsh-mint/issue',
  plan: '/dsh-mint/plan',
  milestone: '/dsh-mint/milestone',
} as const;

/**
 * Resolve a route path against the directory the page is served from.
 *
 * @param path - the route's path, with or without a leading slash.
 * @param baseUri - the page's base; defaults to `document.baseURI`, falling back
 *   to the origin for non-browser callers (tests).
 */
export function apiPath(path: string, baseUri?: string): string {
  const relative = path.replace(/^\/+/, '');
  const base = baseUri ?? (typeof document === 'undefined' ? '/' : document.baseURI);
  return new URL(relative, new URL(base, 'http://localhost/')).pathname;
}

/** Serialize defined, non-empty query values; order is insertion order. */
export function queryString(query: Record<string, string | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== '') params.set(key, value);
  }
  const text = params.toString();
  return text.length === 0 ? '' : `?${text}`;
}

/** True for the refusal envelope both the routes and this module produce. */
function isFailure(value: unknown): value is MintFailurePayload {
  return typeof value === 'object' && value !== null && (value as { ok?: unknown }).ok === false;
}

export interface CreateApiOptions {
  /** The session whose project every request reads. */
  sessionId: string;
  /** Test seam; defaults to the page's `fetch`. */
  fetch?: typeof globalThis.fetch;
  /** Test seam for the mount point; defaults to `document.baseURI`. */
  baseUri?: string;
}

/**
 * Build the panel's transport.
 *
 * @param options - session identity plus the two test seams.
 */
export function createApi(options: CreateApiOptions): MintApiLike {
  const doFetch = options.fetch ?? globalThis.fetch;
  const { sessionId } = options;

  const get = async <T extends { ok: true }>(
    path: string,
    query: Record<string, string | undefined>,
    signal?: AbortSignal
  ): Promise<MintResponse<T>> => {
    const url = `${apiPath(path, options.baseUri)}${queryString({ session: sessionId, ...query })}`;
    try {
      const response = await doFetch(url, {
        method: 'GET',
        headers: { accept: 'application/json' },
        ...(signal === undefined ? {} : { signal }),
      });
      const text = await response.text();
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        return {
          ok: false,
          error: `HTTP ${String(response.status)}: ${text.slice(0, 200) || '(empty body)'}`,
        };
      }
      if (isFailure(raw)) return raw;
      if (!response.ok) return { ok: false, error: `HTTP ${String(response.status)}` };
      return raw as T;
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  };

  return {
    issues: (query, signal) =>
      get<MintListPayload<IssueItem>>(ROUTES.issues, query, signal),
    plans: (query, signal) => get<MintListPayload<PlanItem>>(ROUTES.plans, query, signal),
    milestones: (signal) => get<MintListPayload<MilestoneItem>>(ROUTES.milestones, {}, signal),
    issueBody: (id, signal) => get<MintBodyPayload>(ROUTES.issue, { id: String(id) }, signal),
    plan: (id, signal) =>
      get<MintDetailPayload<ContainerDetail>>(ROUTES.plan, { id: String(id) }, signal),
    milestone: (id, signal) =>
      get<MintDetailPayload<ContainerDetail>>(ROUTES.milestone, { id: String(id) }, signal),
  };
}
