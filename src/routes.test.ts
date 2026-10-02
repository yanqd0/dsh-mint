import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { describe, expect, it } from 'vitest';

import {
  BODY_MAX_BYTES,
  META_LABELS_ARGV,
  META_MILESTONE_LIMIT,
  META_MILESTONES_ARGV,
  META_PLANS_ARGV,
  READ_ONLY_SUBCOMMANDS,
  ROUTE_PREFIX,
  RouteRequestError,
  buildDetailArgv,
  buildIssueDetailArgv,
  buildListArgv,
  buildMilestoneIssuesArgv,
  createMintHandler,
  filterValue,
  installMintRoutes,
  parseId,
  parsePageQuery,
  truncateBody,
} from './routes.js';
import type { MintRouteDeps } from './routes.js';
import type { DshContext } from './types.js';

/** A response double exposing only what the handler touches. */
class FakeResponse extends EventEmitter {
  statusCode = 0;
  headers: Record<string, string> = {};
  body = '';
  writableEnded = false;
  destroyed = false;
  setHeader(name: string, value: string): void {
    this.headers[name.toLowerCase()] = value;
  }
  end(chunk?: string): void {
    this.body += chunk ?? '';
    this.writableEnded = true;
  }
  json(): Record<string, unknown> {
    return JSON.parse(this.body) as Record<string, unknown>;
  }
}

interface RecordedRun {
  cwd: string;
  argv: readonly string[];
}

/** Build a handler over a fake runner; returns both, plus what the runner saw. */
function harness(options: {
  cwd?: string | undefined;
  result?: unknown;
  /** Per-argv result; takes precedence over the single {@link options.result}. */
  byArgv?: (argv: readonly string[]) => unknown;
  entry?: string;
}): {
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  runs: RecordedRun[];
} {
  const runs: RecordedRun[] = [];
  const deps: MintRouteDeps = {
    getCwd: () => options.cwd,
    run: (cwd, argv) => {
      runs.push({ cwd, argv });
      const result = options.byArgv === undefined ? options.result : options.byArgv(argv);
      if (result instanceof Error) return Promise.reject(result);
      if (typeof result === 'string') return Promise.resolve({ ok: true, text: result });
      return Promise.resolve({ ok: false, error: 'boom', stderr: 'mint: hint: boom' });
    },
    ...(options.entry === undefined ? {} : { entry: options.entry }),
  };
  return { handler: createMintHandler(deps), runs };
}

/** Invoke the handler once and return the response double. */
async function invoke(
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
  url: string,
  method = 'GET'
): Promise<FakeResponse> {
  const res = new FakeResponse();
  await handler(
    { method, url } as unknown as IncomingMessage,
    res as unknown as ServerResponse
  );
  return res;
}

const ISSUE_ITEM = {
  id: 9,
  title: '实现 client 打包面',
  kind: 'requirement',
  status: 'dev',
  priority: 0,
  labels: ['agent', 'client'],
  plan_id: 3,
  links: [],
  created_at: '2026-08-29 12:55:45',
  updated_at: '2026-09-01 00:00:00',
};

const ISSUE_DETAIL = {
  ...ISSUE_ITEM,
  body: '## 范围',
  milestone_id: 2,
  uid: 'mach:9',
  test_cmd: null,
};

const PLAN_ITEM = {
  id: 3,
  title: '客户端面：右侧边栏 mint 面板',
  status: 'open',
  version: '0.2.0',
  milestone_id: 2,
  issue_count: 6,
  created_at: '2026-08-29 12:55:45',
  updated_at: '2026-10-01 14:55:55',
};

const MILESTONE_ITEM = {
  id: 2,
  title: '待定：工具面增强与会话 tab',
  status: 'running',
  version: '0.2.0',
  issue_count: 15,
  created_at: '2026-08-29 12:55:45',
  updated_at: '2026-10-01 14:55:32',
};

const PLAN_DETAIL = {
  ...PLAN_ITEM,
  body: '## 范围',
  issues: [{ id: 9, title: '实现 client 打包面', kind: 'requirement', status: 'dev' }],
};

/** A second milestone, so placement has more than one member set to resolve. */
const MILESTONE_ITEM_4 = {
  ...MILESTONE_ITEM,
  id: 4,
  title: '0.3.0 客户端面优化',
  status: 'open',
  version: '0.3.0',
  issue_count: 0,
};

/** One `label list --json` record: the only place a label color exists. */
const LABEL_ITEM = {
  id: 9,
  name: 'client',
  color: '#bbdd3c',
  description: null,
  issue_count: 4,
  created_at: '2026-08-29 12:55:45',
  updated_at: '2026-08-29 12:55:45',
};

describe('route argv builders', () => {
  // The host matches a prefix route with
  // `pathname === prefix || pathname.startsWith(prefix + '/')`.
  // A trailing slash here silently shadows every route behind the SPA fallback
  // (an empty 404), which is exactly what happened once already.
  it('registers a prefix its own routes can match', () => {
    expect(ROUTE_PREFIX.endsWith('/')).toBe(false);
    for (const name of ['issues', 'plans', 'milestones', 'issue', 'plan', 'milestone', 'meta']) {
      const pathname = `${ROUTE_PREFIX}/${name}`;
      expect(pathname === ROUTE_PREFIX || pathname.startsWith(`${ROUTE_PREFIX}/`)).toBe(true);
    }
    // A neighbouring path is not ours.
    expect('/dsh-mint-other'.startsWith(`${ROUTE_PREFIX}/`)).toBe(false);
  });

  it('maps issue filters to their fixed flags', () => {
    const params = new URLSearchParams({
      status: 'open',
      priority: '1',
      label: 'client',
      plan: '3',
      milestone: '2',
      search: '面板',
    });
    expect(buildListArgv('issue', params, { page: 2, pageSize: 10 })).toEqual([
      'list',
      '--json',
      '--status',
      'open',
      '--priority',
      '1',
      '--label',
      'client',
      '--plan',
      '3',
      '--milestone',
      '2',
      '--search',
      '面板',
      '--page',
      '2',
      '--page-size',
      '10',
    ]);
  });

  it('reads every issue state when asked', () => {
    const argv = buildListArgv('issue', new URLSearchParams({ allStates: '1' }), {
      page: 1,
      pageSize: 20,
    });
    expect(argv).toContain('--all-states');
    expect(argv).not.toContain('--status');
  });

  it('keeps plan and milestone lists filter-free where mint offers none', () => {
    expect(buildListArgv('milestone', new URLSearchParams({ status: 'open' }), { page: 1, pageSize: 20 })).toEqual([
      'milestone',
      'list',
      '--json',
      '--page',
      '1',
      '--page-size',
      '20',
    ]);
    expect(buildListArgv('plan', new URLSearchParams({ status: 'open' }), { page: 1, pageSize: 20 })).toContain(
      '--status'
    );
  });

  it('never builds a mutating command', () => {
    const params = new URLSearchParams({ status: 'open', search: 'x' });
    const argvs = [
      buildListArgv('issue', params, { page: 1, pageSize: 20 }),
      buildListArgv('plan', params, { page: 1, pageSize: 20 }),
      buildListArgv('milestone', params, { page: 1, pageSize: 20 }),
      buildIssueDetailArgv(9),
      buildDetailArgv('plan', 3),
      buildDetailArgv('milestone', 2),
      [...META_MILESTONES_ARGV],
      [...META_PLANS_ARGV],
      [...META_LABELS_ARGV],
      buildMilestoneIssuesArgv(2),
      ['label', 'list', '--json', '--no-page'],
    ];
    for (const argv of argvs) {
      expect(READ_ONLY_SUBCOMMANDS).toContain(argv[0]);
      for (const token of argv) {
        expect(['add', 'set', 'state', 'close', 'drop', 'delete', 'import', 'sync', 'attach', 'detach']).not.toContain(
          token
        );
      }
    }
    expect(buildIssueDetailArgv(9)).toEqual(['show', '9', '--json']);
    expect(buildDetailArgv('milestone', 2)).toEqual(['milestone', 'show', '2', '--json']);
  });

  it('refuses values that could become flags', () => {
    expect(() => filterValue(new URLSearchParams({ search: '--all-states' }), 'search')).toThrow(
      RouteRequestError
    );
    expect(() => filterValue(new URLSearchParams({ search: 'x'.repeat(201) }), 'search')).toThrow(
      RouteRequestError
    );
    expect(() => filterValue(new URLSearchParams({ search: 'a\u0000b' }), 'search')).toThrow(
      RouteRequestError
    );
    expect(filterValue(new URLSearchParams(), 'search')).toBeUndefined();
    expect(filterValue(new URLSearchParams({ search: '  ' }), 'search')).toBeUndefined();
  });

  it('requires a numeric id', () => {
    expect(parseId(new URLSearchParams({ id: '42' }))).toBe(42);
    expect(() => parseId(new URLSearchParams({ id: '4;rm' }))).toThrow(RouteRequestError);
    expect(() => parseId(new URLSearchParams())).toThrow(RouteRequestError);
  });

  it('defaults and clamps pagination, rejecting nonsense', () => {
    expect(parsePageQuery(new URLSearchParams())).toEqual({ page: 1, pageSize: 20 });
    expect(parsePageQuery(new URLSearchParams({ page: '0', pageSize: '500' }))).toEqual({
      page: 1,
      pageSize: 100,
    });
    expect(() => parsePageQuery(new URLSearchParams({ page: 'two' }))).toThrow(RouteRequestError);
  });

  it('truncates a body on a byte boundary', () => {
    expect(truncateBody('短')).toEqual({ body: '短', truncated: false });
    const long = 'a'.repeat(BODY_MAX_BYTES + 1);
    expect(truncateBody(long)).toEqual({ body: 'a'.repeat(BODY_MAX_BYTES), truncated: true });
    // Multi-byte characters must not be cut in half.
    const wide = '汉'.repeat(BODY_MAX_BYTES);
    const cut = truncateBody(wide);
    expect(cut.truncated).toBe(true);
    expect(Buffer.byteLength(cut.body, 'utf8')).toBeLessThanOrEqual(BODY_MAX_BYTES);
  });
});

describe('mint routes', () => {
  it('reads the session project, never a browser-supplied path', async () => {
    const { handler, runs } = harness({ cwd: '/proj', result: JSON.stringify({ items: [ISSUE_ITEM] }) });
    const res = await invoke(handler, `${ROUTE_PREFIX}/issues?session=s1&cwd=/etc`);
    expect(runs[0]?.cwd).toBe('/proj');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, total: 1 });
  });

  it('serves issues with pagination and shape warnings', async () => {
    const payload = JSON.stringify({
      items: [ISSUE_ITEM, { id: 'nope' }],
      page: 3,
      page_size: 5,
      pages: 4,
      total: 17,
    });
    const { handler } = harness({ cwd: '/proj', result: payload });
    const res = await invoke(handler, `${ROUTE_PREFIX}/issues?session=s1`);
    expect(res.json()).toMatchObject({
      ok: true,
      items: [ISSUE_ITEM],
      page: 3,
      page_size: 5,
      pages: 4,
      total: 17,
    });
    expect((res.json().warnings as string[])[0]).toContain('1/2 items missing required fields');
  });

  it('serves plan and milestone lists and details', async () => {
    const planRun = harness({ cwd: '/proj', result: JSON.stringify({ items: [PLAN_ITEM] }) });
    const planList = await invoke(planRun.handler, `${ROUTE_PREFIX}/plans?session=s1`);
    expect(planList.json()).toMatchObject({ ok: true, items: [PLAN_ITEM] });

    const msRun = harness({ cwd: '/proj', result: JSON.stringify({ items: [MILESTONE_ITEM] }) });
    const msList = await invoke(msRun.handler, `${ROUTE_PREFIX}/milestones?session=s1`);
    expect(msList.json()).toMatchObject({ ok: true, items: [MILESTONE_ITEM] });

    const detailRun = harness({ cwd: '/proj', result: JSON.stringify(PLAN_DETAIL) });
    const detail = await invoke(detailRun.handler, `${ROUTE_PREFIX}/plan?session=s1&id=3`);
    expect(detailRun.runs[0]?.argv).toEqual(['plan', 'show', '3', '--json']);
    expect(detail.json()).toMatchObject({ ok: true, plan: { id: 3, body: '## 范围' } });
  });

  it('serves one issue in full, truncating a body that is too large', async () => {
    const item = { ...ISSUE_DETAIL, body: 'short body' };
    const { handler, runs } = harness({ cwd: '/proj', result: JSON.stringify(item) });
    const res = await invoke(handler, `${ROUTE_PREFIX}/issue?session=s1&id=9`);
    expect(runs[0]?.argv).toEqual(['show', '9', '--json']);
    expect(res.json()).toEqual({ ok: true, item, truncated: false });
  });

  it('refuses an unreadable issue instead of inventing one', async () => {
    const { handler } = harness({ cwd: '/proj', result: JSON.stringify({ id: 9 }) });
    const res = await invoke(handler, `${ROUTE_PREFIX}/issue?session=s1&id=9`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: false });
  });

  it('reports a CLI failure as a normal payload, not an HTTP error', async () => {
    const { handler } = harness({ cwd: '/proj', result: 1 });
    const res = await invoke(handler, `${ROUTE_PREFIX}/issues?session=s1`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: false, error: 'boom', stderr: 'mint: hint: boom' });
  });

  it('serves the panel dictionary and issue placement in one response', async () => {
    const run = harness({
      cwd: '/proj',
      byArgv: (argv) => {
        if (argv[0] === 'milestone') return JSON.stringify({ items: [MILESTONE_ITEM, MILESTONE_ITEM_4] });
        if (argv[0] === 'plan') return JSON.stringify({ items: [PLAN_ITEM] });
        if (argv[0] === 'label') return JSON.stringify({ items: [LABEL_ITEM] });
        if (argv[0] === 'list' && argv[3] === '2') {
          return JSON.stringify({
            items: [ISSUE_ITEM, { ...ISSUE_ITEM, id: 69, plan_id: null }],
          });
        }
        return JSON.stringify({ items: [{ ...ISSUE_ITEM, id: 87, plan_id: null }] });
      },
    });
    const res = await invoke(run.handler, `${ROUTE_PREFIX}/meta?session=s1`);
    expect(res.json()).toMatchObject({
      ok: true,
      plans: [PLAN_ITEM],
      milestones: [MILESTONE_ITEM, MILESTONE_ITEM_4],
      labels: [LABEL_ITEM],
      placement: {
        '9': { milestone: 2, direct: false },
        '69': { milestone: 2, direct: true },
        '87': { milestone: 4, direct: true },
      },
    });
    expect(run.runs.map((entry) => entry.argv)).toEqual(
      expect.arrayContaining([
        [...META_MILESTONES_ARGV],
        [...META_PLANS_ARGV],
        [...META_LABELS_ARGV],
        buildMilestoneIssuesArgv(2),
        buildMilestoneIssuesArgv(4),
      ])
    );
  });

  it('keeps the rest of the response when one milestone placement read fails', async () => {
    const run = harness({
      cwd: '/proj',
      byArgv: (argv) => {
        if (argv[0] === 'milestone') return JSON.stringify({ items: [MILESTONE_ITEM, MILESTONE_ITEM_4] });
        if (argv[0] === 'plan') return JSON.stringify({ items: [PLAN_ITEM] });
        if (argv[0] === 'label') return JSON.stringify({ items: [LABEL_ITEM] });
        if (argv[0] === 'list' && argv[3] === '2') return 1; // the runner turns this into a CLI failure
        return JSON.stringify({ items: [{ ...ISSUE_ITEM, id: 87, plan_id: null }] });
      },
    });
    const res = await invoke(run.handler, `${ROUTE_PREFIX}/meta?session=s1`);
    const payload = res.json();
    expect(payload.ok).toBe(true);
    expect(payload.placement).toEqual({ '87': { milestone: 4, direct: true } });
    expect(payload.warnings as string[]).toEqual([
      expect.stringContaining('milestone #2 issue placement unavailable'),
    ]);
  });

  it('refuses the whole response when a dictionary read fails', async () => {
    const run = harness({
      cwd: '/proj',
      byArgv: (argv) => (argv[0] === 'plan' ? 1 : JSON.stringify({ items: [] })),
    });
    const res = await invoke(run.handler, `${ROUTE_PREFIX}/meta?session=s1`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: false, error: 'boom' });
  });

  it('caps how many milestones it scans for placement', async () => {
    const many = Array.from({ length: META_MILESTONE_LIMIT + 1 }, (_value, index) => ({
      ...MILESTONE_ITEM,
      id: index + 1,
    }));
    const run = harness({
      cwd: '/proj',
      byArgv: (argv) => {
        if (argv[0] === 'milestone') return JSON.stringify({ items: many });
        if (argv[0] === 'plan' || argv[0] === 'label') return JSON.stringify({ items: [] });
        return JSON.stringify({ items: [] });
      },
    });
    const res = await invoke(run.handler, `${ROUTE_PREFIX}/meta?session=s1`);
    const scans = run.runs.filter((entry) => entry.argv[2] === '--milestone');
    expect(scans).toHaveLength(META_MILESTONE_LIMIT);
    expect(res.json().warnings as string[]).toEqual([
      expect.stringContaining(`first ${String(META_MILESTONE_LIMIT)} of 31 milestones`),
    ]);
  });

  it('aborts every run of a request when the client disconnects', async () => {
    const signals: AbortSignal[] = [];
    const handler = createMintHandler({
      getCwd: () => '/proj',
      run: (_cwd, _argv, options) =>
        new Promise((resolve) => {
          const signal = options?.signal;
          if (signal !== undefined) signals.push(signal);
          signal?.addEventListener('abort', () => {
            resolve({ ok: false, error: 'aborted' });
          });
        }),
    });
    const res = new FakeResponse();
    const pending = handler(
      { method: 'GET', url: `${ROUTE_PREFIX}/meta?session=s1` } as unknown as IncomingMessage,
      res as unknown as ServerResponse
    );
    await new Promise((resolve) => setImmediate(resolve));
    // The dictionary reads are in flight together; one disconnect ends them all.
    expect(signals.length).toBe(3);
    res.emit('close');
    await pending;
    for (const signal of signals) expect(signal.aborted).toBe(true);
    expect(res.body).toBe('');
  });

  it('refuses an unknown session, an unknown route, a bad id, and a non-GET', async () => {
    const unknownSession = harness({ cwd: undefined, result: '{}' });
    const refused = await invoke(unknownSession.handler, `${ROUTE_PREFIX}/issues?session=gone`);
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toEqual({ ok: false, error: 'session-not-live' });

    const known = harness({ cwd: '/proj', result: '{}' });
    const missing = await invoke(known.handler, `${ROUTE_PREFIX}/nope?session=s1`);
    expect(missing.statusCode).toBe(404);

    const badId = await invoke(known.handler, `${ROUTE_PREFIX}/issue?session=s1&id=x`);
    expect(badId.statusCode).toBe(400);

    const posted = await invoke(known.handler, `${ROUTE_PREFIX}/issues?session=s1`, 'POST');
    expect(posted.statusCode).toBe(405);
    expect(posted.headers['allow']).toBe('GET');
  });

  it('passes the configured mint entry through to every run', async () => {
    const seen: Array<unknown> = [];
    const deps: MintRouteDeps = {
      getCwd: () => '/proj',
      entry: '~/bin/mint',
      run: (_cwd, _argv, options) => {
        seen.push(options?.entry);
        return Promise.resolve({ ok: true, text: '{}' });
      },
    };
    await invoke(createMintHandler(deps), `${ROUTE_PREFIX}/milestones?session=s1`);
    expect(seen).toEqual(['~/bin/mint']);
  });
});

describe('installMintRoutes', () => {
  /** A scoped context whose `effect` behaves like cordis': it runs the callback. */
  function scopedCarrier(onRegister: (route: { kind: string; path: string }) => void): DshContext {
    return {
      on: () => () => {},
      effect: (callback, label) => {
        expect(label).toContain('dsh-mint');
        callback();
        return () => {};
      },
      webServer: {
        register: (route) => {
          onRegister({ kind: route.kind, path: route.path });
          return () => {};
        },
      },
    };
  }

  it('registers one prefix route once the carrier exists', () => {
    const registered: Array<{ kind: string; path: string }> = [];
    const ctx: DshContext = {
      on: () => () => {},
      get: () => ({ get: () => ({ session: { header: { cwd: '/proj' } } }) }),
      inject: (services, callback) => {
        expect(services).toEqual(['webServer']);
        callback(scopedCarrier((route) => registered.push(route)));
      },
    };
    installMintRoutes(ctx, undefined);
    expect(registered).toEqual([{ kind: 'prefix', path: ROUTE_PREFIX }]);
  });

  it('registers anyway on a scoped context without an effect seam', () => {
    const registered: Array<{ kind: string; path: string }> = [];
    installMintRoutes(
      {
        on: () => () => {},
        inject: (_services, callback) => {
          callback({
            on: () => () => {},
            webServer: {
              register: (route) => {
                registered.push({ kind: route.kind, path: route.path });
                return () => {};
              },
            },
          });
        },
      },
      undefined
    );
    expect(registered).toEqual([{ kind: 'prefix', path: ROUTE_PREFIX }]);
  });

  it('does nothing on a context without the carrier or the seam', () => {
    expect(() => installMintRoutes({ on: () => () => {} }, undefined)).not.toThrow();
    expect(() =>
      installMintRoutes(
        {
          on: () => () => {},
          inject: (_services, callback) => {
            callback({ on: () => () => {} });
          },
        },
        undefined
      )
    ).not.toThrow();
  });
});
