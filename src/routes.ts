/**
 * Read-only HTTP routes backing the right-sidebar mint panel (#10).
 *
 * An installed (static) plugin's browser half cannot reach the host through the
 * Typert Remote assembly — `dsh-api-remotes` fixes its capability set at build
 * time — and `harness.handle`/`host.call` belong to the *dynamic* Cordis package
 * runner. The working seam is the other one every shipped feature uses: the host
 * registers exact routes on `ctx.webServer`, the browser half `fetch`es them.
 *
 * What this module may run is deliberately tiny: a fixed subcommand per route
 * plus numeric/enumerated arguments. Nothing here can express a write, and
 * `READ_ONLY_SUBCOMMANDS` is asserted by the tests rather than trusted.
 *
 * The project a request reads is derived from its session — never from a path
 * the browser supplies — so the panel cannot be pointed at an arbitrary database.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

import { isValidDagSession, sampleOf } from './dag.js';
import type { DagSample } from './dag.js';
import { withSample } from './dag-lifecycle.js';
import { lastMeasurement, readDagMetrics } from './dag-metrics.js';
import { DAG_DIR, readDag, updateDag } from './dag-store.js';
import type { DagRead } from './dag-store.js';
import {
  isContainerDetail,
  isIssueDetail,
  isIssueItem,
  isLabelItem,
  isMilestoneItem,
  isPlanItem,
  parseDetail,
  parseItems,
} from './mint-json.js';
import type { ParsedItems } from './mint-json.js';
import { runMint } from './mint.js';
import type { MintRunOptions, MintRunResult } from './mint.js';
import type { DagNodeMetrics, IssuePlacement } from './records.js';
import { ROUTE_PREFIX, isRouteName } from './route-paths.js';
import { hasControlCharacter } from './text.js';
import type { AgentsLike, DshContext, SessionProjectionsLike, WebServerLike } from './types.js';

/**
 * Re-exported from {@link ./route-paths.js}: the prefix is shared with the
 * browser half, which builds the same paths for its `fetch`es (#104).
 */
export { ROUTE_PREFIX };

/** The panel truncates an issue body at this many UTF-8 bytes. */
export const BODY_MAX_BYTES = 256 * 1024;

/** Where pagination starts when the panel asks for nothing. */
export const DEFAULT_PAGE = 1;
export const DEFAULT_PAGE_SIZE = 20;
/** mint's `--page-size` is happy with more, but a panel is not a report. */
export const MAX_PAGE_SIZE = 100;

/** Longest accepted filter value; a filter is a needle, not a document. */
const MAX_FILTER_LENGTH = 200;

/**
 * The only mint subcommands these routes run. Everything reachable from here is
 * a read: `list`, `show`, `plan list`, `plan show`, `milestone list`,
 * `milestone show`, `label list`. Any argv whose head is outside this list is a
 * bug — `label` is here for the color dictionary only, never `label set`.
 */
export const READ_ONLY_SUBCOMMANDS = ['list', 'show', 'plan', 'issue', 'milestone', 'label'] as const;

/**
 * How many milestones the meta route scans for issue placement.
 *
 * Placement has no bulk read (see {@link META_MILESTONE_ARGV}): one milestone
 * costs one CLI run, so a pathological project must degrade to a warning instead
 * of spawning hundreds of children.
 */
export const META_MILESTONE_LIMIT = 30;

/**
 * How long one placement scan answers further panel requests (#105).
 *
 * Placement has no bulk read (see {@link buildMilestoneIssuesArgv}), so a single
 * request costs one CLI run per milestone, up to {@link META_MILESTONE_LIMIT}.
 * The three dictionary tables are still re-read on every request — they are what
 * the panel navigates — while the issue→milestone map is remembered for this
 * window. The panel's explicit refresh sends `refresh=1` and bypasses it, so a
 * user who just changed an attachment never waits for the TTL.
 */
export const PLACEMENT_TTL_MS = 10_000;

/** The three whole-table reads the meta route always performs, unpaginated. */
export const META_MILESTONES_ARGV: readonly string[] = [
  'milestone',
  'list',
  '--all-states',
  '--json',
  '--no-page',
];
export const META_PLANS_ARGV: readonly string[] = ['plan', 'list', '--all-states', '--json', '--no-page'];
export const META_LABELS_ARGV: readonly string[] = ['label', 'list', '--json', '--no-page'];

/**
 * The argv that lists one milestone's issues.
 *
 * This is the temporary stand-in for mint exposing an issue's effective
 * milestone on `list --json` (dsh-mint plan #15 → mint #503). `--milestone`
 * already means "effective milestone (direct, else via plan)" in mint, and the
 * items carry `plan_id`, which is how the caller tells the two apart.
 *
 * @param id - the milestone to enumerate.
 */
export function buildMilestoneIssuesArgv(id: number): string[] {
  return ['list', '--all-states', '--milestone', String(id), '--json', '--no-page'];
}

/** A request these routes refuse: bad path, bad id, or a bad filter. */
export class RouteRequestError extends Error {}

/**
 * The `(session, node)` pairs whose remembered measurement this process has
 * already persisted (#168).
 *
 * The fallback below runs on every DAG poll — twice a second while a plan is on
 * screen — so without this every read of a node the host can no longer measure
 * would be another locked read-modify-write of the same file. What is being
 * remembered is that the *cache* has been flushed for that node, not that the
 * file has a sample: a node whose document was later rewritten by hand is not
 * re-persisted either, which is the intended "once per process" contract.
 */
const flushedSamples = new Set<string>();

/** Which collection a `list` route reads. */
export type ListKind = 'issue' | 'plan' | 'milestone';

/** Validated pagination. */
export interface PageQuery {
  page: number;
  pageSize: number;
}

/** The `run` seam, so tests need no module mock to drive a route. */
export type MintRunner = (
  cwd: string,
  args: readonly string[],
  options?: MintRunOptions
) => Promise<MintRunResult>;

export interface MintRouteDeps {
  /** Resolve a live session's project directory; `undefined` for an unknown one. */
  getCwd(sessionId: string): string | undefined;
  /** mint CLI entry override (`mintEntry` on the mount line). */
  entry?: string;
  /** Defaults to {@link runMint}; tests replace it. */
  run?: MintRunner;
  /** Clock seam for the placement TTL (#105); defaults to `Date.now`. */
  now?: () => number;
  /** DAG directory override (plan #31); defaults to {@link DAG_DIR}. */
  dagDir?: string;
  /** Mount-line `openDagTab`, published in the DAG envelope; defaults to true. */
  openDagTab?: boolean;
  /** Per-node live metrics for one session's DAG; absent in tests/lean hosts. */
  readDagMetrics?(sessionId: string): Promise<Record<string, DagNodeMetrics>>;
}

/**
 * One in-flight request: the response to answer, the project to read, and the
 * abort signal every CLI run it starts shares.
 */
interface RequestScope {
  res: ServerResponse;
  cwd: string;
  signal: AbortSignal;
}

/** Read `page` / `pageSize`: missing means default, malformed means 400. */
export function parsePageQuery(params: URLSearchParams): PageQuery {
  return {
    page: pageCounter(params.get('page'), DEFAULT_PAGE, Number.MAX_SAFE_INTEGER),
    pageSize: pageCounter(params.get('pageSize'), DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE),
  };
}

function pageCounter(raw: string | null, fallback: number, max: number): number {
  if (raw === null) return fallback;
  if (!/^\d+$/.test(raw)) throw new RouteRequestError(`not a page number: ${raw}`);
  return Math.min(Math.max(Number(raw), 1), max);
}

/**
 * Read one filter value.
 *
 * A value may not begin with `-` — that is what would turn it into a flag for
 * the CLI — and may not carry control characters. Since `spawn` receives an argv
 * array there is no shell to escape, so these two rules plus the fixed subcommand
 * are the whole injection surface.
 */
export function filterValue(params: URLSearchParams, name: string): string | undefined {
  const raw = params.get(name);
  if (raw === null) return undefined;
  const value = raw.trim();
  if (value.length === 0) return undefined;
  if (value.length > MAX_FILTER_LENGTH) throw new RouteRequestError(`${name} is too long`);
  if (value.startsWith('-')) throw new RouteRequestError(`${name} must not start with "-"`);
  if (hasControlCharacter(value)) throw new RouteRequestError(`${name} has control characters`);
  return value;
}

/** Read the numeric `id` a detail route addresses. */
export function parseId(params: URLSearchParams): number {
  const raw = params.get('id') ?? '';
  if (!/^\d+$/.test(raw)) throw new RouteRequestError('id must be a positive integer');
  return Number(raw);
}

/**
 * Build the argv for one `list` route.
 *
 * This is the pass-through form: whatever the flags can express in one call.
 * The container routes go through {@link containerListRequest} instead, which
 * overrides it when the panel's "open or running" default needs a full-table
 * read; the issue route is the only caller of this function directly.
 *
 * @param kind - which collection to read.
 * @param params - the request's query.
 * @param page - validated pagination.
 * @throws {RouteRequestError} on a malformed filter value.
 */
export function buildListArgv(kind: ListKind, params: URLSearchParams, page: PageQuery): string[] {
  const argv = kind === 'issue' ? ['list', '--json'] : [kind, 'list', '--json'];
  if (kind === 'issue') {
    if (params.get('allStates') === '1') {
      argv.push('--all-states');
    } else {
      const status = filterValue(params, 'status');
      if (status !== undefined) argv.push('--status', status);
    }
    pushFilter(argv, params, 'priority', '--priority');
    pushFilter(argv, params, 'label', '--label');
    pushFilter(argv, params, 'plan', '--plan');
    pushFilter(argv, params, 'milestone', '--milestone');
    pushFilter(argv, params, 'search', '--search');
  } else {
    // Containers (plan | milestone): `--all-states` wins over `--status`, the
    // same precedence the issue branch takes — the two contradict each other and
    // the panel never sends both.
    if (params.get('allStates') === '1') argv.push('--all-states');
    else pushFilter(argv, params, 'status', '--status');
    pushFilter(argv, params, 'milestone', '--milestone');
    pushFilter(argv, params, 'search', '--search');
  }
  argv.push('--page', String(page.page), '--page-size', String(page.pageSize));
  return argv;
}

/**
 * The container states the panel treats as settled.
 *
 * mint's own `plan list` / `milestone list` hide only `done`, but `partial`
 * (every issue settled, never released) and `dropped` (cancelled) are the rest
 * of a container's end states. Only these three are named: a state mint grows
 * later stays visible rather than disappearing silently.
 */
export const CONTAINER_END_STATES: readonly string[] = ['partial', 'dropped', 'done'];

/** One container list request: the argv to run, and how to read its answer. */
export interface ContainerListRequest {
  argv: string[];
  /**
   * True when {@link argv} read the whole table (`--no-page`): the route must
   * drop the settled containers and cut the requested page itself.
   */
  filterSettled: boolean;
}

/**
 * Build the request behind `/dsh-mint/plans` or `/dsh-mint/milestones`.
 *
 * The panel's default is "open or running", which mint cannot be asked for: its
 * own default hides only `done`, and `--status` accepts a single value (a
 * repeated flag is a usage error). So the default path reads the whole
 * all-states table — the same read the meta route already makes — and
 * {@link settledContainerPage} filters and pages it here.
 *
 * An explicit `status` or `allStates` is expressible as one CLI call and passes
 * straight through.
 *
 * @param kind - which container list to read.
 * @param params - the request's query.
 * @param page - validated pagination.
 * @throws {RouteRequestError} on a malformed filter value.
 */
export function containerListRequest(
  kind: 'plan' | 'milestone',
  params: URLSearchParams,
  page: PageQuery
): ContainerListRequest {
  if (params.get('allStates') === '1' || filterValue(params, 'status') !== undefined) {
    return { argv: buildListArgv(kind, params, page), filterSettled: false };
  }
  const argv = [kind, 'list', '--all-states', '--json', '--no-page'];
  pushFilter(argv, params, 'milestone', '--milestone');
  pushFilter(argv, params, 'search', '--search');
  return { argv, filterSettled: true };
}

/** The page a list route answers with, once its selection is applied. */
export interface ListPage<T> {
  items: T[];
  page: number;
  pageSize: number;
  pages: number;
  total: number;
}

/**
 * Drop the settled containers and cut the requested page out of the rest.
 *
 * `--no-page` still carries mint's counters for the *unfiltered* table, so both
 * the total and the slice are recomputed here.
 *
 * @param items - every container the CLI returned.
 * @param page - the page the caller asked for.
 */
export function settledContainerPage<T extends { status: string }>(
  items: readonly T[],
  page: PageQuery
): ListPage<T> {
  const active = items.filter((item) => !CONTAINER_END_STATES.includes(item.status));
  const total = active.length;
  const start = (page.page - 1) * page.pageSize;
  return {
    items: active.slice(start, start + page.pageSize),
    page: page.page,
    pageSize: page.pageSize,
    pages: total === 0 ? 1 : Math.ceil(total / page.pageSize),
    total,
  };
}

function pushFilter(
  argv: string[],
  params: URLSearchParams,
  name: string,
  flag: string
): void {
  const value = filterValue(params, name);
  if (value !== undefined) argv.push(flag, value);
}

/**
 * Build the argv that reads one issue in full.
 *
 * `show --json` is the only read that carries both the list fields and the body,
 * which is what lets a plan or milestone detail open an issue without a second
 * lookup and without inventing fields the list does not have.
 */
export function buildIssueDetailArgv(id: number): string[] {
  return ['show', String(id), '--json'];
}

/** Build the argv that reads one container's detail (`plan show` / `milestone show`). */
export function buildDetailArgv(kind: 'plan' | 'milestone', id: number): string[] {
  return [kind, 'show', String(id), '--json'];
}

/** Write a JSON response; the browser half reads only this body. */
function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  if (res.writableEnded || res.destroyed) return;
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(body);
}

/** Name a CLI failure for the panel, keeping mint's own stderr advisory lines. */
function failure(result: MintRunResult): Record<string, unknown> {
  const error = result.error ?? `mint exited with code ${String(result.exitCode ?? 'unknown')}`;
  const stderr = result.stderr?.trim();
  return stderr !== undefined && stderr.length > 0 ? { error, stderr } : { error };
}

/**
 * Truncate a body on a UTF-8 boundary, reporting whether it was cut.
 *
 * `null` is mint's own "no body" answer (#94/#95) and passes through untouched:
 * the panel already renders both `null` and `''` as the empty state, so there is
 * nothing to normalize here and nothing to fabricate.
 *
 * @param text - the record's body, or `null` when it has none.
 */
export function truncateBody(text: string | null): { body: string | null; truncated: boolean } {
  if (text === null) return { body: null, truncated: false };
  if (Buffer.byteLength(text, 'utf8') <= BODY_MAX_BYTES) return { body: text, truncated: false };
  // Byte length is monotonic in the prefix length, so binary-search the longest
  // prefix that fits instead of trimming one character at a time.
  let low = 0;
  let high = Math.min(text.length, BODY_MAX_BYTES);
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, mid), 'utf8') <= BODY_MAX_BYTES) low = mid;
    else high = mid - 1;
  }
  // Never leave a lone surrogate behind: an astral character is a pair.
  if (low > 0 && /[\uD800-\uDBFF]/.test(text.charAt(low - 1))) low -= 1;
  return { body: text.slice(0, low), truncated: true };
}

/**
 * Persist the readings this process still remembers but the document does not
 * carry, at most once per `(session, node)` per process (#168/#166).
 *
 * The trigger is "the document has no sample for this node, and this answer
 * could not measure it": the child is gone (the registry dropped it — this is
 * what the real host does by the time `subagent/end` fires, so the lifecycle
 * hook cannot measure either) or the composition has no projection registry,
 * and only the reading remembered while the child was alive is left. The
 * reading's own `at` is what gets stored: it is the moment the host *measured*
 * the node, not the moment this write happened to run.
 *
 * A node this answer *did* measure is skipped while that reading is live — the
 * cached numbers change on every poll, so persisting them would bump the
 * revision the panel re-renders on, for a reading the next answer replaces. Once
 * the live read stops, the next answer persists the last cached one. Nothing
 * here measures anything, so the route stays a reader.
 *
 * The whole step is best-effort and its caller does not depend on it: a failed
 * or skipped write costs this answer nothing but the fallback the *next* answer
 * would have shown.
 *
 * @param sessionId - the session whose document is being answered.
 * @param read - what this request just read from disk (the node list).
 * @param measured - node ids this answer measured live; empty when it measured none.
 * @param dir - the DAG directory override.
 */
async function flushRememberedSample(
  sessionId: string,
  read: DagRead,
  measured: ReadonlySet<string>,
  dir: string
): Promise<void> {
  if (read.state !== 'ok') return;
  const pending: Array<{ nodeId: string; sample: DagSample }> = [];
  for (const node of read.doc.nodes) {
    if (measured.has(node.id)) continue;
    if (read.doc.samples?.[node.id] !== undefined) continue;
    const remembered = lastMeasurement(sessionId, node.id);
    if (remembered === undefined) continue;
    const sample = sampleOf(remembered, remembered.at ?? Date.now());
    if (sample === undefined) continue;
    pending.push({ nodeId: node.id, sample });
  }
  if (pending.length === 0) return;
  // Marked before the write: one attempt per node per process, however that
  // attempt ends (the file may be unreadable, or already carry a newer sample).
  for (const { nodeId } of pending) flushedSamples.add(`${sessionId}\u0000${nodeId}`);
  try {
    await updateDag(
      sessionId,
      (state) => {
        if (state.state !== 'ok') return { skip: true };
        let doc = state.doc;
        const now = new Date().toISOString();
        for (const { nodeId, sample } of pending) {
          doc = withSample(doc, nodeId, { ...sample, at: sample.at }, now) ?? doc;
        }
        return doc === state.doc ? { skip: true } : { doc };
      },
      dir
    );
  } catch {
    // Best-effort: the answer below is already the panel's, and a write of a
    // *measurement* is never worth turning a 200 into an error.
  }
}

/**
 * Build the route handler.
 *
 * @param deps - the session lookup, the optional CLI entry override, and the run seam.
 * @returns a handler for `ctx.webServer.register`.
 */
export function createMintHandler(
  deps: MintRouteDeps
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const run = deps.run ?? runMint;
  const now = deps.now ?? Date.now;

  /**
   * Answer the plan DAG route (plan #31).
   *
   * This route is **file-keyed, not project-keyed**: the DAG lives next to the
   * session id, no mint CLI runs, and the browser half polls it while its tab is
   * visible. So it is answered before the live-session lookup — a session whose
   * project cannot be resolved still has a graph to draw, and a panel that
   * outlives its session degrades to the empty state instead of a 400.
   */
  const sendDag = async (res: ServerResponse, params: URLSearchParams): Promise<void> => {
    const sessionId = params.get('session') ?? '';
    // Validated before it can become a path segment; a bad id is a caller bug.
    if (!isValidDagSession(sessionId)) {
      throw new RouteRequestError('session must be a 1-64 char [A-Za-z0-9_-] id');
    }
    const read: DagRead = await readDag(sessionId, deps.dagDir ?? DAG_DIR);
    // Host-measured usage is best-effort by design (#162): the panel must get
    // its graph even when the projections cannot be read, so a failure here is
    // the same as no metrics — and nothing is published unless something was
    // really measured, so "absent" never has to mean "zero".
    let metrics: Record<string, DagNodeMetrics> | undefined;
    let measuredLive: Record<string, DagNodeMetrics> = {};
    if (deps.readDagMetrics !== undefined && read.state === 'ok' && read.doc.nodes.length > 0) {
      try {
        measuredLive = await deps.readDagMetrics(sessionId);
        if (Object.keys(measuredLive).length > 0) metrics = measuredLive;
      } catch {
        measuredLive = {};
        metrics = undefined;
      }
    }
    // A node this answer could not measure has only one source left: the reading
    // remembered while the child was alive (#168). Flush it into the document,
    // once per process, so the next answer's stored fallback carries it even
    // after a restart. Keyed on "no live reading" rather than on the node's
    // status: the child is already gone by the time the host settles it.
    await flushRememberedSample(
      sessionId,
      read,
      new Set(Object.keys(measuredLive).filter((id) => measuredLive[id] !== undefined)),
      deps.dagDir ?? DAG_DIR
    );
    // `warnings` is declared rather than inferred: the payload it spreads into
    // is `unknown`-typed, and a lone inferred string[] would read as a mistake.
    const warnings: Record<string, unknown> =
      read.state === 'unreadable' ? { warnings: [`unreadable dag: ${read.error}`] } : {};
    sendJson(res, 200, {
      ok: true,
      // A missing file and an unreadable one both answer `dag: null`: "this
      // session has no DAG yet" is a normal state, not a 404 (§4.2/§1.5).
      dag: read.state === 'ok' ? read.doc : null,
      revision: read.state === 'ok' ? read.doc.revision : 0,
      file: read.file,
      autoOpen: deps.openDagTab ?? true,
      // One sample clock for the whole answer: `sampled_at` is what the panel
      // compares the per-node numbers against, so it is read once, here.
      ...(metrics === undefined ? {} : { metrics, sampled_at: now() }),
      ...warnings,
    });
  };

  /**
   * The issue→milestone map, per project, for {@link PLACEMENT_TTL_MS} (#105).
   *
   * Scoped to the handler (i.e. the plugin's lifetime) rather than to a request:
   * the expensive part is the per-milestone fan-out, and a panel that reopens or
   * switches views asks for it again within seconds.
   */
  const placementCache = new Map<
    string,
    { at: number; placement: Record<string, IssuePlacement> }
  >();

  /**
   * Run mint under the request's lifetime; `undefined` once the client left.
   *
   * The signal is the request's own ({@link RequestScope}), not this call's: a
   * route that reads several tables in parallel (the meta route) must not
   * register one `close` listener per child, and one disconnect should cancel
   * every run it started.
   */
  const runForRequest = async (
    scope: RequestScope,
    argv: string[]
  ): Promise<MintRunResult | undefined> => {
    if (scope.signal.aborted) return undefined;
    const options: MintRunOptions =
      deps.entry === undefined
        ? { signal: scope.signal }
        : { signal: scope.signal, entry: deps.entry };
    const result = await run(scope.cwd, argv, options);
    return scope.signal.aborted ? undefined : result;
  };

  const sendList = async <T>(
    scope: RequestScope,
    argv: string[],
    source: string,
    isItem: (value: unknown) => value is T,
    /**
     * Optional selection: maps the parsed page onto the one to answer with.
     * Absent means "the CLI's own page is the answer".
     */
    select?: (parsed: ParsedItems<T>) => ListPage<T>
  ): Promise<void> => {
    const result = await runForRequest(scope, argv);
    if (result === undefined) return;
    if (!result.ok) {
      sendJson(scope.res, 200, { ok: false, ...failure(result) });
      return;
    }
    const parsed = parseItems(source, result.text, isItem, { noun: 'list' });
    const page = select === undefined ? parsed : select(parsed);
    sendJson(scope.res, 200, {
      ok: true,
      items: page.items,
      page: page.page,
      page_size: page.pageSize,
      pages: page.pages,
      total: page.total,
      ...(parsed.warning === undefined ? {} : { warnings: [parsed.warning] }),
    });
  };

  /**
   * Serve one container list through the panel's settled-state default.
   *
   * @param kind - which container table to read.
   * @param params - the request's query.
   * @param page - validated pagination.
   * @param isItem - the guard for that table's records.
   */
  const sendContainerList = async <T extends { status: string }>(
    scope: RequestScope,
    kind: 'plan' | 'milestone',
    params: URLSearchParams,
    page: PageQuery,
    isItem: (value: unknown) => value is T
  ): Promise<void> => {
    const request = containerListRequest(kind, params, page);
    await sendList(
      scope,
      request.argv,
      `${kind} list --json`,
      isItem,
      request.filterSettled ? (parsed) => settledContainerPage(parsed.items, page) : undefined
    );
  };

  /**
   * Serve the panel's lookup tables in one response.
   *
   * Three whole-table reads plus one run per milestone (the temporary placement
   * stand-in, {@link buildMilestoneIssuesArgv}) — all in parallel, because each
   * is an independent child process. A per-milestone failure costs that
   * milestone's placement and a warning, never the whole response: the panel can
   * still draw every row it already has.
   *
   * The scan is memoized for {@link PLACEMENT_TTL_MS} per project (#105); the
   * caller's `refresh=1` forces a fresh one.
   */
  const sendMeta = async (scope: RequestScope, params: URLSearchParams): Promise<void> => {
    const [milestones, plans, labels] = await Promise.all([
      runForRequest(scope, [...META_MILESTONES_ARGV]),
      runForRequest(scope, [...META_PLANS_ARGV]),
      runForRequest(scope, [...META_LABELS_ARGV]),
    ]);
    if (milestones === undefined || plans === undefined || labels === undefined) return;
    // The dictionary reads are the response's spine: without them, nothing the
    // panel renders would be trustworthy, so the first failure answers for all.
    const failed = [milestones, plans, labels].find((result) => !result.ok);
    if (failed !== undefined) {
      sendJson(scope.res, 200, { ok: false, ...failure(failed) });
      return;
    }

    const warnings: string[] = [];
    const milestonePage = parseItems(
      'milestone list --json',
      milestones.text,
      isMilestoneItem,
      { noun: 'meta' }
    );
    const planPage = parseItems('plan list --json', plans.text, isPlanItem, { noun: 'meta' });
    const labelPage = parseItems('label list --json', labels.text, isLabelItem, { noun: 'meta' });
    for (const warning of [milestonePage.warning, planPage.warning, labelPage.warning]) {
      if (warning !== undefined) warnings.push(warning);
    }

    const scan = milestonePage.items.slice(0, META_MILESTONE_LIMIT);
    if (milestonePage.items.length > scan.length) {
      warnings.push(
        `meta: placement scanned the first ${String(META_MILESTONE_LIMIT)} of ${String(milestonePage.items.length)} milestones`
      );
    }

    const cacheKey = `${deps.entry ?? ''}\u0000${scope.cwd}`;
    const cached = placementCache.get(cacheKey);
    if (params.get('refresh') !== '1' && cached !== undefined && now() - cached.at < PLACEMENT_TTL_MS) {
      sendJson(scope.res, 200, {
        ok: true,
        plans: planPage.items,
        milestones: milestonePage.items,
        labels: labelPage.items,
        placement: cached.placement,
        ...(warnings.length === 0 ? {} : { warnings }),
      });
      return;
    }

    const members = await Promise.all(
      scan.map(async (milestone) => ({
        id: milestone.id,
        result: await runForRequest(scope, buildMilestoneIssuesArgv(milestone.id)),
      }))
    );

    const placement: Record<string, IssuePlacement> = {};
    for (const { id, result } of members) {
      if (result === undefined) continue;
      if (!result.ok) {
        warnings.push(`meta: milestone #${String(id)} issue placement unavailable`);
        continue;
      }
      const page = parseItems(`list --milestone ${String(id)} --json`, result.text, isIssueItem, {
        noun: 'meta',
      });
      if (page.warning !== undefined) warnings.push(page.warning);
      for (const item of page.items) {
        // mint answers `--milestone` with the effective milestone, so a member
        // without a plan is the direct case and everyone else is via that plan.
        placement[String(item.id)] = { milestone: id, direct: item.plan_id === null };
      }
    }
    // A client that disconnected mid-scan keeps no answer (#105): `placement`
    // would then be a partial map that reads as real data for the whole TTL.
    if (!scope.signal.aborted) {
      placementCache.set(cacheKey, { at: now(), placement });
    }

    sendJson(scope.res, 200, {
      ok: true,
      plans: planPage.items,
      milestones: milestonePage.items,
      labels: labelPage.items,
      placement,
      ...(warnings.length === 0 ? {} : { warnings }),
    });
  };

  return async (req, res) => {
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      sendJson(res, 405, { ok: false, error: 'method-not-allowed' });
      return;
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    // Mirror the host's own prefix rule: `/dsh-mint/issues` is ours,
    // `/dsh-mint-other` is not.
    const name = url.pathname.startsWith(`${ROUTE_PREFIX}/`)
      ? url.pathname.slice(ROUTE_PREFIX.length + 1)
      : '';
    const params = url.searchParams;

    // One lifetime for the whole request: every CLI run it starts shares this
    // signal, so a disconnect cancels all of them and adds a single listener.
    const controller = new AbortController();
    const onClose = (): void => {
      if (!res.writableEnded) controller.abort();
    };
    res.on('close', onClose);

    try {
      if (name === 'dag') {
        await sendDag(res, params);
        return;
      }
      if (isRouteName(name)) {
        const sessionId = params.get('session') ?? '';
        const cwd = deps.getCwd(sessionId);
        if (cwd === undefined) {
          sendJson(res, 400, { ok: false, error: 'session-not-live' });
          return;
        }
        const scope: RequestScope = { res, cwd, signal: controller.signal };
        const page = parsePageQuery(params);
        switch (name) {
          case 'issues':
            await sendList(scope, buildListArgv('issue', params, page), 'list --json', isIssueItem);
            return;
          case 'plans':
            await sendContainerList(scope, 'plan', params, page, isPlanItem);
            return;
          case 'milestones':
            await sendContainerList(scope, 'milestone', params, page, isMilestoneItem);
            return;
          case 'meta':
            await sendMeta(scope, params);
            return;
          case 'issue': {
            const id = parseId(params);
            const result = await runForRequest(scope, buildIssueDetailArgv(id));
            if (result === undefined) return;
            if (!result.ok) {
              sendJson(res, 200, { ok: false, ...failure(result) });
              return;
            }
            const parsed = parseDetail('show --json', result.text, isIssueDetail);
            if (parsed.value === undefined) {
              sendJson(res, 200, { ok: false, error: parsed.warning ?? 'unreadable issue' });
              return;
            }
            const cut = truncateBody(parsed.value.body);
            const item = cut.truncated ? { ...parsed.value, body: cut.body } : parsed.value;
            sendJson(res, 200, { ok: true, item, truncated: cut.truncated });
            return;
          }
          default: {
            const kind = name === 'plan' ? 'plan' : 'milestone';
            const id = parseId(params);
            const result = await runForRequest(scope, buildDetailArgv(kind, id));
            if (result === undefined) return;
            if (!result.ok) {
              sendJson(res, 200, { ok: false, ...failure(result) });
              return;
            }
            const parsed = parseDetail(`${kind} show --json`, result.text, isContainerDetail);
            if (parsed.value === undefined) {
              sendJson(res, 200, { ok: false, error: parsed.warning ?? 'unreadable detail' });
              return;
            }
            sendJson(res, 200, { ok: true, [kind]: parsed.value });
            return;
          }
        }
      }
      sendJson(res, 404, { ok: false, error: 'unknown-route' });
    } catch (error) {
      if (error instanceof RouteRequestError) {
        sendJson(res, 400, { ok: false, error: error.message });
        return;
      }
      sendJson(res, 500, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      res.off('close', onClose);
    }
  };
}

/**
 * Register the panel's routes on the host's browser carrier.
 *
 * `webServer` is optional by design: a headless or ACP composition runs the
 * plugin's other faces and simply has no routes to serve.
 *
 * @param ctx - the plugin's root context.
 * @param entry - `mintEntry` from the mount line, forwarded to every run.
 * @param options - mount-line client knobs: the DAG tab's auto-open default and
 *   the DAG directory override (plan #31; tests point the latter at a temp dir).
 */
export function installMintRoutes(
  ctx: DshContext,
  entry?: string,
  options?: { openDagTab?: boolean; dagDir?: string }
): void {
  ctx.inject?.(['webServer'], (scoped) => {
    const webServer: WebServerLike | undefined = scoped.webServer;
    if (webServer === undefined) return;
    const handler = createMintHandler({
      getCwd: (sessionId) => {
        // The service is looked up per request so a composition that mounts the
        // agent registry later still resolves; the cast is the usual structural
        // narrowing at the host boundary.
        const agents = ctx.get?.('agents') as AgentsLike | undefined;
        return agents?.get(sessionId)?.session.header.cwd;
      },
      // Same live lookup as `getCwd`, for the same reason: the projection
      // registry may be mounted after this plugin starts. `projections` is
      // forwarded even when absent — `readDagMetrics` owns the one degradation
      // rule (`{}`), so there is no second place to keep in sync.
      readDagMetrics: (sessionId) => {
        const agents = ctx.get?.('agents') as AgentsLike | undefined;
        const projections = ctx.get?.('sessionProjections') as SessionProjectionsLike | undefined;
        return readDagMetrics({
          sessionId,
          ...(options?.dagDir === undefined ? {} : { dagDir: options.dagDir }),
          agents,
          projections,
          sampledMs: Date.now(),
        });
      },
      ...(entry === undefined ? {} : { entry }),
      ...(options?.openDagTab === undefined ? {} : { openDagTab: options.openDagTab }),
      ...(options?.dagDir === undefined ? {} : { dagDir: options.dagDir }),
    });
    const register = (): (() => void) =>
      webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler });
    if (scoped.effect !== undefined) {
      scoped.effect(register, 'dsh-mint: client query routes');
      return;
    }
    // A lean context without `effect` still gets working routes; nothing owns
    // the disposer, which only matters for hot reload.
    register();
  });
}
