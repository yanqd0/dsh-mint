import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { describe, expect, it } from 'vitest';

import {
  BODY_MAX_BYTES,
  READ_ONLY_SUBCOMMANDS,
  ROUTE_PREFIX,
  RouteRequestError,
  buildDetailArgv,
  buildIssueBodyArgv,
  buildListArgv,
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
      const result = options.result;
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

describe('route argv builders', () => {
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
      buildIssueBodyArgv(9),
      buildDetailArgv('plan', 3),
      buildDetailArgv('milestone', 2),
    ];
    for (const argv of argvs) {
      expect(READ_ONLY_SUBCOMMANDS).toContain(argv[0]);
      for (const token of argv) {
        expect(['add', 'set', 'state', 'close', 'drop', 'delete', 'import', 'sync', 'attach', 'detach']).not.toContain(
          token
        );
      }
    }
    expect(buildIssueBodyArgv(9)).toEqual(['issue', 'get', '9', 'body']);
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
    const res = await invoke(handler, `${ROUTE_PREFIX}issues?session=s1&cwd=/etc`);
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
    const res = await invoke(handler, `${ROUTE_PREFIX}issues?session=s1`);
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
    const planList = await invoke(planRun.handler, `${ROUTE_PREFIX}plans?session=s1`);
    expect(planList.json()).toMatchObject({ ok: true, items: [PLAN_ITEM] });

    const msRun = harness({ cwd: '/proj', result: JSON.stringify({ items: [MILESTONE_ITEM] }) });
    const msList = await invoke(msRun.handler, `${ROUTE_PREFIX}milestones?session=s1`);
    expect(msList.json()).toMatchObject({ ok: true, items: [MILESTONE_ITEM] });

    const detailRun = harness({ cwd: '/proj', result: JSON.stringify(PLAN_DETAIL) });
    const detail = await invoke(detailRun.handler, `${ROUTE_PREFIX}plan?session=s1&id=3`);
    expect(detailRun.runs[0]?.argv).toEqual(['plan', 'show', '3', '--json']);
    expect(detail.json()).toMatchObject({ ok: true, plan: { id: 3, body: '## 范围' } });
  });

  it('serves an issue body, truncating what is too large', async () => {
    const { handler, runs } = harness({ cwd: '/proj', result: 'body text' });
    const res = await invoke(handler, `${ROUTE_PREFIX}issue?session=s1&id=9`);
    expect(runs[0]?.argv).toEqual(['issue', 'get', '9', 'body']);
    expect(res.json()).toEqual({ ok: true, body: 'body text', truncated: false });
  });

  it('reports a CLI failure as a normal payload, not an HTTP error', async () => {
    const { handler } = harness({ cwd: '/proj', result: 1 });
    const res = await invoke(handler, `${ROUTE_PREFIX}issues?session=s1`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: false, error: 'boom', stderr: 'mint: hint: boom' });
  });

  it('refuses an unknown session, an unknown route, a bad id, and a non-GET', async () => {
    const unknownSession = harness({ cwd: undefined, result: '{}' });
    const refused = await invoke(unknownSession.handler, `${ROUTE_PREFIX}issues?session=gone`);
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toEqual({ ok: false, error: 'session-not-live' });

    const known = harness({ cwd: '/proj', result: '{}' });
    const missing = await invoke(known.handler, `${ROUTE_PREFIX}nope?session=s1`);
    expect(missing.statusCode).toBe(404);

    const badId = await invoke(known.handler, `${ROUTE_PREFIX}issue?session=s1&id=x`);
    expect(badId.statusCode).toBe(400);

    const posted = await invoke(known.handler, `${ROUTE_PREFIX}issues?session=s1`, 'POST');
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
    await invoke(createMintHandler(deps), `${ROUTE_PREFIX}milestones?session=s1`);
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
