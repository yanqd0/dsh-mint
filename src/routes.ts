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

import { parseDetail, parseItems, isContainerDetail, isIssueItem, isMilestoneItem, isPlanItem } from './mint-json.js';
import { runMint } from './mint.js';
import type { MintRunOptions, MintRunResult } from './mint.js';
import type { AgentsLike, DshContext, WebServerLike } from './types.js';

/** Every route lives under this prefix; one registration owns the whole space. */
export const ROUTE_PREFIX = '/dsh-mint/';

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
 * a read: `list`, `plan list`, `plan show`, `issue get`, `milestone list`,
 * `milestone show`. Any argv whose head is outside this list is a bug.
 */
export const READ_ONLY_SUBCOMMANDS = ['list', 'plan', 'issue', 'milestone'] as const;

/** The six routes this prefix answers; anything else is a 404. */
const ROUTE_NAMES: readonly string[] = ['issues', 'plans', 'milestones', 'issue', 'plan', 'milestone'];

/** A request these routes refuse: bad path, bad id, or a bad filter. */
export class RouteRequestError extends Error {}

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

/** True when the value carries C0/DEL control characters. */
function hasControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
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
  } else if (kind === 'plan') {
    pushFilter(argv, params, 'status', '--status');
    pushFilter(argv, params, 'milestone', '--milestone');
    pushFilter(argv, params, 'search', '--search');
  }
  argv.push('--page', String(page.page), '--page-size', String(page.pageSize));
  return argv;
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

/** Build the argv that reads one issue's body (the raw, unparsed field). */
export function buildIssueBodyArgv(id: number): string[] {
  return ['issue', 'get', String(id), 'body'];
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

/** Truncate a body on a UTF-8 boundary, reporting whether it was cut. */
export function truncateBody(text: string): { body: string; truncated: boolean } {
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
 * Build the route handler.
 *
 * @param deps - the session lookup, the optional CLI entry override, and the run seam.
 * @returns a handler for `ctx.webServer.register`.
 */
export function createMintHandler(
  deps: MintRouteDeps
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const run = deps.run ?? runMint;

  /** Run mint under the request's lifetime; `undefined` once the client left. */
  const runForRequest = async (
    res: ServerResponse,
    cwd: string,
    argv: string[]
  ): Promise<MintRunResult | undefined> => {
    const controller = new AbortController();
    const onClose = (): void => {
      if (!res.writableEnded) controller.abort();
    };
    res.on('close', onClose);
    try {
      const options: MintRunOptions =
        deps.entry === undefined
          ? { signal: controller.signal }
          : { signal: controller.signal, entry: deps.entry };
      const result = await run(cwd, argv, options);
      return controller.signal.aborted ? undefined : result;
    } finally {
      res.off('close', onClose);
    }
  };

  const sendList = async <T>(
    res: ServerResponse,
    cwd: string,
    argv: string[],
    source: string,
    isItem: (value: unknown) => value is T
  ): Promise<void> => {
    const result = await runForRequest(res, cwd, argv);
    if (result === undefined) return;
    if (!result.ok) {
      sendJson(res, 200, { ok: false, ...failure(result) });
      return;
    }
    const parsed = parseItems(source, result.text, isItem, { noun: 'list' });
    sendJson(res, 200, {
      ok: true,
      items: parsed.items,
      page: parsed.page,
      page_size: parsed.pageSize,
      pages: parsed.pages,
      total: parsed.total,
      ...(parsed.warning === undefined ? {} : { warnings: [parsed.warning] }),
    });
  };

  return async (req, res) => {
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      sendJson(res, 405, { ok: false, error: 'method-not-allowed' });
      return;
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    const name = url.pathname.startsWith(ROUTE_PREFIX)
      ? url.pathname.slice(ROUTE_PREFIX.length)
      : '';
    const params = url.searchParams;

    try {
      if (ROUTE_NAMES.includes(name)) {
        const sessionId = params.get('session') ?? '';
        const cwd = deps.getCwd(sessionId);
        if (cwd === undefined) {
          sendJson(res, 400, { ok: false, error: 'session-not-live' });
          return;
        }
        const page = parsePageQuery(params);
        switch (name) {
          case 'issues':
            await sendList(res, cwd, buildListArgv('issue', params, page), 'list --json', isIssueItem);
            return;
          case 'plans':
            await sendList(res, cwd, buildListArgv('plan', params, page), 'plan list --json', isPlanItem);
            return;
          case 'milestones':
            await sendList(
              res,
              cwd,
              buildListArgv('milestone', params, page),
              'milestone list --json',
              isMilestoneItem
            );
            return;
          case 'issue': {
            const id = parseId(params);
            const result = await runForRequest(res, cwd, buildIssueBodyArgv(id));
            if (result === undefined) return;
            if (!result.ok) {
              sendJson(res, 200, { ok: false, ...failure(result) });
              return;
            }
            sendJson(res, 200, { ok: true, ...truncateBody(result.text ?? '') });
            return;
          }
          default: {
            const kind = name === 'plan' ? 'plan' : 'milestone';
            const id = parseId(params);
            const result = await runForRequest(res, cwd, buildDetailArgv(kind, id));
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
 */
export function installMintRoutes(ctx: DshContext, entry?: string): void {
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
      ...(entry === undefined ? {} : { entry }),
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
