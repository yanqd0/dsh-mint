import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { applyDagWrite, emptyDag } from './dag.js';
import { rememberMeasurement } from './dag-metrics.js';
import { dagFilePath, readDag, updateDag } from './dag-store.js';
import {
  BODY_MAX_BYTES,
  META_LABELS_ARGV,
  META_MILESTONE_LIMIT,
  META_MILESTONES_ARGV,
  META_PLANS_ARGV,
  PLACEMENT_TTL_MS,
  READ_ONLY_SUBCOMMANDS,
  ROUTE_PREFIX,
  RouteRequestError,
  buildDetailArgv,
  buildIssueDetailArgv,
  buildListArgv,
  buildMilestoneIssuesArgv,
  containerListRequest,
  createMintHandler,
  filterValue,
  installMintRoutes,
  parseId,
  parsePageQuery,
  settledContainerPage,
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
  /** Clock seam for the placement TTL (#105). */
  now?: () => number;
  /** DAG directory override: the plan DAG route is file-keyed (plan #31). */
  dagDir?: string;
  /** Mount-line `openDagTab`, published in the DAG envelope. */
  openDagTab?: boolean;
  /** Per-node live metrics seam for the DAG route (#162). */
  readDagMetrics?: MintRouteDeps['readDagMetrics'];
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
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.dagDir === undefined ? {} : { dagDir: options.dagDir }),
    ...(options.openDagTab === undefined ? {} : { openDagTab: options.openDagTab }),
    ...(options.readDagMetrics === undefined ? {} : { readDagMetrics: options.readDagMetrics }),
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

  it('maps container filters onto the flags mint offers', () => {
    expect(buildListArgv('milestone', new URLSearchParams({ status: 'open' }), { page: 1, pageSize: 20 })).toEqual([
      'milestone',
      'list',
      '--json',
      '--status',
      'open',
      '--page',
      '1',
      '--page-size',
      '20',
    ]);
    expect(
      buildListArgv('plan', new URLSearchParams({ status: 'open', search: '面板' }), {
        page: 2,
        pageSize: 10,
      })
    ).toEqual([
      'plan',
      'list',
      '--json',
      '--status',
      'open',
      '--search',
      '面板',
      '--page',
      '2',
      '--page-size',
      '10',
    ]);
  });

  it('reads every container state when the settled ones are asked for', () => {
    for (const kind of ['plan', 'milestone'] as const) {
      const argv = buildListArgv(kind, new URLSearchParams({ allStates: '1', status: 'partial' }), {
        page: 2,
        pageSize: 10,
      });
      // allStates wins over status: the two flags contradict each other.
      expect(argv).toEqual([
        kind,
        'list',
        '--json',
        '--all-states',
        '--page',
        '2',
        '--page-size',
        '10',
      ]);
    }
  });

  it('never builds a mutating command', () => {
    const params = new URLSearchParams({ status: 'open', search: 'x' });
    const argvs = [
      buildListArgv('issue', params, { page: 1, pageSize: 20 }),
      buildListArgv('plan', params, { page: 1, pageSize: 20 }),
      buildListArgv('milestone', params, { page: 1, pageSize: 20 }),
      containerListRequest('plan', params, { page: 1, pageSize: 20 }).argv,
      containerListRequest('milestone', new URLSearchParams(), { page: 1, pageSize: 20 }).argv,
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
    // mint's own "no body" answer passes through untouched (#94/#95).
    expect(truncateBody(null)).toEqual({ body: null, truncated: false });
    const long = 'a'.repeat(BODY_MAX_BYTES + 1);
    expect(truncateBody(long)).toEqual({ body: 'a'.repeat(BODY_MAX_BYTES), truncated: true });
    // Multi-byte characters must not be cut in half.
    const wide = '汉'.repeat(BODY_MAX_BYTES);
    const cut = truncateBody(wide);
    expect(cut.truncated).toBe(true);
    expect(cut.body).not.toBeNull();
    expect(Buffer.byteLength(cut.body ?? '', 'utf8')).toBeLessThanOrEqual(BODY_MAX_BYTES);
  });
});

describe('container list policy', () => {
  it('reads the whole table and filters settled containers itself by default', () => {
    for (const kind of ['plan', 'milestone'] as const) {
      const request = containerListRequest(
        kind,
        new URLSearchParams({ milestone: '2', search: '面板' }),
        { page: 1, pageSize: 20 }
      );
      expect(request.filterSettled).toBe(true);
      expect(request.argv).toEqual([
        kind,
        'list',
        '--all-states',
        '--json',
        '--no-page',
        '--milestone',
        '2',
        '--search',
        '面板',
      ]);
    }
  });

  it('passes an explicit status or all-states straight through to mint', () => {
    expect(
      containerListRequest('plan', new URLSearchParams({ status: 'partial' }), {
        page: 1,
        pageSize: 20,
      })
    ).toEqual({
      argv: ['plan', 'list', '--json', '--status', 'partial', '--page', '1', '--page-size', '20'],
      filterSettled: false,
    });
    expect(
      containerListRequest('milestone', new URLSearchParams({ allStates: '1' }), {
        page: 3,
        pageSize: 5,
      })
    ).toEqual({
      argv: ['milestone', 'list', '--json', '--all-states', '--page', '3', '--page-size', '5'],
      filterSettled: false,
    });
  });

  it('refuses a status that could become a flag', () => {
    for (const kind of ['plan', 'milestone'] as const) {
      expect(() =>
        containerListRequest(kind, new URLSearchParams({ status: '--all-states' }), {
          page: 1,
          pageSize: 20,
        })
      ).toThrow(RouteRequestError);
    }
  });

  it('drops the settled states and pages the remainder itself', () => {
    const open = { id: 1, status: 'open' };
    const running = { id: 3, status: 'running' };
    const later = { id: 6, status: 'open' };
    const containers = [
      open,
      { id: 2, status: 'partial' },
      running,
      { id: 4, status: 'dropped' },
      { id: 5, status: 'done' },
      later,
    ];
    expect(settledContainerPage(containers, { page: 1, pageSize: 2 })).toEqual({
      items: [open, running],
      page: 1,
      pageSize: 2,
      pages: 2,
      total: 3,
    });
    expect(settledContainerPage(containers, { page: 2, pageSize: 2 }).items).toEqual([later]);
  });

  it('keeps a filtered page well-shaped when it is empty', () => {
    // Past the end: the requested number survives, the client's clampPage
    // converges on the next render.
    expect(
      settledContainerPage([{ id: 1, status: 'open' }], { page: 9, pageSize: 20 })
    ).toMatchObject({ items: [], page: 9, pages: 1, total: 1 });
    // Only settled containers: one empty page, never zero pages.
    expect(settledContainerPage([{ id: 7, status: 'done' }], { page: 1, pageSize: 20 })).toEqual({
      items: [],
      page: 1,
      pageSize: 20,
      pages: 1,
      total: 0,
    });
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

  it('hides the settled containers unless the panel asks for them', async () => {
    const containers = [
      { ...PLAN_ITEM, id: 1, status: 'open' },
      { ...PLAN_ITEM, id: 2, status: 'partial' },
      { ...PLAN_ITEM, id: 3, status: 'dropped' },
      { ...PLAN_ITEM, id: 4, status: 'done' },
      { ...PLAN_ITEM, id: 5, status: 'running' },
    ];
    const run = harness({
      cwd: '/proj',
      result: JSON.stringify({ items: containers, page: 1, page_size: 5, pages: 1, total: 5 }),
    });
    const filtered = await invoke(run.handler, `${ROUTE_PREFIX}/plans?session=s1`);
    expect(run.runs[0]?.argv).toEqual(['plan', 'list', '--all-states', '--json', '--no-page']);
    expect(filtered.json()).toMatchObject({
      ok: true,
      items: [{ id: 1, status: 'open' }, { id: 5, status: 'running' }],
      page: 1,
      page_size: 20,
      pages: 1,
      total: 2,
    });

    const all = await invoke(
      run.handler,
      `${ROUTE_PREFIX}/plans?session=s1&allStates=1&page=2&pageSize=2`
    );
    expect(run.runs[1]?.argv).toEqual([
      'plan',
      'list',
      '--json',
      '--all-states',
      '--page',
      '2',
      '--page-size',
      '2',
    ]);
    expect(all.json()).toMatchObject({ ok: true, page: 1, page_size: 5, pages: 1, total: 5 });
  });

  it('applies the same settled-state policy to the milestone table', async () => {
    const run = harness({
      cwd: '/proj',
      result: JSON.stringify({
        items: [{ ...MILESTONE_ITEM, id: 3, status: 'dropped' }, MILESTONE_ITEM],
      }),
    });
    const res = await invoke(run.handler, `${ROUTE_PREFIX}/milestones?session=s1&pageSize=10`);
    expect(run.runs[0]?.argv).toEqual(['milestone', 'list', '--all-states', '--json', '--no-page']);
    expect(res.json()).toMatchObject({ ok: true, items: [{ id: 2 }], page_size: 10, total: 1 });
  });

  it('keeps records mint answers with null fields (#94/#95/#96)', async () => {
    // `plan create` without --milestone leaves version null; a container or
    // issue created without --body answers body null. Those are declared
    // answers, not shape drift: requiring a string dropped whole records and
    // raised a false "missing required fields" warning.
    const plan = { ...PLAN_ITEM, id: 9, version: null, milestone_id: null };
    const planRun = harness({
      cwd: '/proj',
      result: JSON.stringify({ items: [plan], page: 1, page_size: 5, pages: 1, total: 1 }),
    });
    const plans = await invoke(planRun.handler, `${ROUTE_PREFIX}/plans?session=s1`);
    expect(plans.json()).toMatchObject({ ok: true, items: [plan], total: 1 });
    expect(plans.json().warnings).toBeUndefined();

    const milestone = { ...MILESTONE_ITEM, version: null };
    const msRun = harness({ cwd: '/proj', result: JSON.stringify({ items: [milestone] }) });
    const milestones = await invoke(msRun.handler, `${ROUTE_PREFIX}/milestones?session=s1`);
    expect(milestones.json()).toMatchObject({ ok: true, items: [milestone] });

    const container = { ...PLAN_DETAIL, version: null, body: null };
    const detailRun = harness({ cwd: '/proj', result: JSON.stringify(container) });
    const planDetail = await invoke(detailRun.handler, `${ROUTE_PREFIX}/plan?session=s1&id=3`);
    expect(planDetail.json()).toMatchObject({ ok: true, plan: { version: null, body: null } });

    const issue = { ...ISSUE_DETAIL, body: null };
    const issueRun = harness({ cwd: '/proj', result: JSON.stringify(issue) });
    const issueDetail = await invoke(issueRun.handler, `${ROUTE_PREFIX}/issue?session=s1&id=9`);
    expect(issueDetail.json()).toEqual({ ok: true, item: issue, truncated: false });

    // The same plan must survive into the lookup tables /meta builds.
    const metaRun = harness({
      cwd: '/proj',
      byArgv: (argv) => {
        if (argv[0] === 'milestone') return JSON.stringify({ items: [milestone] });
        if (argv[0] === 'plan') return JSON.stringify({ items: [plan] });
        if (argv[0] === 'label') return JSON.stringify({ items: [LABEL_ITEM] });
        return JSON.stringify({ items: [] });
      },
    });
    const meta = await invoke(metaRun.handler, `${ROUTE_PREFIX}/meta?session=s1`);
    expect(meta.json()).toMatchObject({ ok: true, plans: [plan] });
    expect(meta.json().warnings).toBeUndefined();
  });

  it('keeps a label mint has no color for (#108)', async () => {
    // mint types the color column as nullable; the label must stay in the
    // dictionary so its name keeps resolving, and the panel tints it neutrally.
    const label = { ...LABEL_ITEM, id: 20, name: 'imported', color: null };
    const run = harness({
      cwd: '/proj',
      byArgv: (argv) => {
        if (argv[0] === 'milestone' || argv[0] === 'plan') return JSON.stringify({ items: [] });
        return JSON.stringify({ items: [label] });
      },
    });
    const res = await invoke(run.handler, `${ROUTE_PREFIX}/meta?session=s1`);
    expect(res.json()).toMatchObject({ ok: true, labels: [label] });
    expect(res.json().warnings).toBeUndefined();
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

  it('memoizes the placement scan and lets refresh=1 bypass it (#105)', async () => {
    let clock = 1_000;
    const run = harness({
      cwd: '/proj',
      now: () => clock,
      byArgv: (argv) => {
        if (argv[0] === 'milestone') return JSON.stringify({ items: [MILESTONE_ITEM, MILESTONE_ITEM_4] });
        if (argv[0] === 'plan') return JSON.stringify({ items: [PLAN_ITEM] });
        if (argv[0] === 'label') return JSON.stringify({ items: [LABEL_ITEM] });
        return JSON.stringify({ items: [{ ...ISSUE_ITEM, id: 87, plan_id: null }] });
      },
    });
    const placementRuns = (): number =>
      run.runs.filter((entry) => entry.argv[0] === 'list').length;

    await invoke(run.handler, `${ROUTE_PREFIX}/meta?session=s1`);
    expect(placementRuns()).toBe(2);
    // Same handler, same project, inside the TTL: the dictionaries are re-read,
    // the (expensive) placement scan is not.
    await invoke(run.handler, `${ROUTE_PREFIX}/meta?session=s1`);
    expect(placementRuns()).toBe(2);
    expect(run.runs.filter((entry) => entry.argv[0] === 'milestone')).toHaveLength(2);

    // The panel's own refresh must not wait for the TTL.
    await invoke(run.handler, `${ROUTE_PREFIX}/meta?session=s1&refresh=1`);
    expect(placementRuns()).toBe(4);

    // Once the TTL lapses the next request rescans by itself.
    clock += PLACEMENT_TTL_MS;
    await invoke(run.handler, `${ROUTE_PREFIX}/meta?session=s1`);
    expect(placementRuns()).toBe(6);
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

describe('the plan DAG route (plan #31)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-mint-dag-route-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Seed one session's document through the real store, not a stub. */
  async function seed(session: string, title: string): Promise<void> {
    const initialized = await updateDag(
      session,
      () => ({ doc: emptyDag(session, title, '2026-01-01T00:00:00.000Z') }),
      dir
    );
    expect(initialized.ok).toBe(true);
    const added = await updateDag(
      session,
      (state) => {
        if (state.state !== 'ok') throw new Error('seed: missing document');
        return applyDagWrite(
          {
            action: 'add',
            nodes: [{ id: 'a', label: '总①', title: '第一轮', phase: 'exec', depends_on: [] }],
            edges: [],
          },
          state.doc,
          session,
          '2026-01-01T00:00:00.000Z'
        );
      },
      dir
    );
    expect(added.ok).toBe(true);
  }

  it('answers a session without a DAG with 200 and dag:null', async () => {
    const { handler } = harness({ cwd: '/proj', dagDir: dir });
    const res = await invoke(handler, `${ROUTE_PREFIX}/dag?session=s1`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ok: true,
      dag: null,
      revision: 0,
      file: dagFilePath('s1', dir),
      autoOpen: true,
    });
  });

  it('serves the stored document with its revision', async () => {
    await seed('s1', '宿主面 DAG');
    const { handler } = harness({ cwd: '/proj', dagDir: dir });
    const res = await invoke(handler, `${ROUTE_PREFIX}/dag?session=s1`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      ok: true,
      revision: 2,
      autoOpen: true,
      dag: {
        title: '宿主面 DAG',
        nodes: [{ id: 'a', label: '总①', title: '第一轮', phase: 'exec', status: 'pending' }],
        edges: [],
      },
    });
  });

  it('publishes host-measured node metrics with the sample clock (#162)', async () => {
    await seed('s1', '宿主面 DAG');
    const asked: string[] = [];
    const { handler } = harness({
      cwd: '/proj',
      dagDir: dir,
      now: () => 1_700_000_000_000,
      readDagMetrics: (sessionId) => {
        asked.push(sessionId);
        return Promise.resolve({ a: { tokens: 123, elapsed_ms: 4500 } });
      },
    });
    const res = await invoke(handler, `${ROUTE_PREFIX}/dag?session=s1`);
    expect(res.statusCode).toBe(200);
    const payload = res.json();
    expect(payload).toMatchObject({
      ok: true,
      metrics: { a: { tokens: 123, elapsed_ms: 4500 } },
      sampled_at: 1_700_000_000_000,
    });
    expect(typeof payload.sampled_at).toBe('number');
    // The reader is asked about this session's DAG, once per request.
    expect(asked).toEqual(['s1']);
  });

  it('omits metrics and sampled_at unless the host really measured something (#162)', async () => {
    await seed('s1', '宿主面 DAG');
    // The keys the envelope has when it carries no metrics: absent, never
    // `{}` + 0, so an old panel and a lean host keep the same shape.
    const withoutMetrics = ['autoOpen', 'dag', 'file', 'ok', 'revision'];

    // Default: no reader at all (tests and lean hosts).
    const plain = await invoke(
      harness({ cwd: '/proj', dagDir: dir }).handler,
      `${ROUTE_PREFIX}/dag?session=s1`
    );
    const plainPayload = plain.json();
    expect(plainPayload.dag).not.toBeNull();
    expect(Object.keys(plainPayload).sort()).toEqual(withoutMetrics);

    // A reader that measured nothing is the same as no reader.
    const empty = await invoke(
      harness({ cwd: '/proj', dagDir: dir, readDagMetrics: () => Promise.resolve({}) }).handler,
      `${ROUTE_PREFIX}/dag?session=s1`
    );
    const emptyPayload = empty.json();
    expect(emptyPayload.dag).not.toBeNull();
    expect(Object.keys(emptyPayload).sort()).toEqual(withoutMetrics);
    expect(emptyPayload).not.toHaveProperty('metrics');
    expect(emptyPayload).not.toHaveProperty('sampled_at');
  });

  it('keeps answering the graph when the metrics read throws (#162)', async () => {
    await seed('s1', '宿主面 DAG');
    const { handler } = harness({
      cwd: '/proj',
      dagDir: dir,
      readDagMetrics: () => Promise.reject(new Error('projection registry gone')),
    });
    const res = await invoke(handler, `${ROUTE_PREFIX}/dag?session=s1`);
    expect(res.statusCode).toBe(200);
    const payload = res.json();
    expect(payload).toMatchObject({ ok: true, revision: 2, dag: { nodes: [{ id: 'a' }] } });
    expect(payload).not.toHaveProperty('metrics');
    expect(payload).not.toHaveProperty('sampled_at');
  });

  it('does not read metrics for a session with nothing to measure (#162)', async () => {
    const spy = vi.fn(() => Promise.resolve({ a: { tokens: 1 } }));
    const { handler } = harness({ cwd: '/proj', dagDir: dir, readDagMetrics: spy });
    // A missing document answers `dag: null` and asks the host nothing.
    const missing = await invoke(handler, `${ROUTE_PREFIX}/dag?session=s1`);
    expect(missing.json()).toEqual({
      ok: true,
      dag: null,
      revision: 0,
      file: dagFilePath('s1', dir),
      autoOpen: true,
    });
    // A stored document without a node has nothing to measure either.
    const initialized = await updateDag(
      's2',
      () => ({ doc: emptyDag('s2', '空 DAG', '2026-01-01T00:00:00.000Z') }),
      dir
    );
    expect(initialized.ok).toBe(true);
    const empty = await invoke(handler, `${ROUTE_PREFIX}/dag?session=s2`);
    expect(empty.json()).toMatchObject({ ok: true, revision: 1, dag: { nodes: [] } });
    expect(spy).not.toHaveBeenCalled();
  });

  it('is file-keyed: it answers without a live session and spawns no CLI', async () => {
    const { handler, runs } = harness({ cwd: undefined, dagDir: dir });
    const res = await invoke(handler, `${ROUTE_PREFIX}/dag?session=s1`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, dag: null });
    expect(runs).toEqual([]);
  });

  // #168: a node whose child the host can no longer measure still has the
  // reading the lifecycle remembered, and the route is what flushes it into the
  // document — once, so a polling panel does not rewrite the same file forever.
  describe('the remembered-sample fallback (#168)', () => {
    /** The sample the document carries for `node`, as it was persisted. */
    async function storedSample(
      session: string,
      node: string
    ): Promise<{ tokens?: number; at?: number } | undefined> {
      const read = await readDag(session, dir);
      if (read.state !== 'ok') throw new Error(`no document for ${session}`);
      return read.doc.samples?.[node];
    }

    /** Seed a session whose single node is still running, as a live plan is. */
    async function seedRunning(session: string): Promise<void> {
      await seed(session, '样本 DAG');
      const started = await updateDag(
        session,
        (state) => {
          if (state.state !== 'ok') return { skip: true };
          return applyDagWrite(
            { action: 'set', id: 'a', status: 'running' },
            state.doc,
            session,
            '2026-01-02T00:00:00.000Z'
          );
        },
        dir
      );
      expect(started.ok).toBe(true);
    }

    it('writes the remembered reading once, then leaves the file alone', async () => {
      await seedRunning('s168a');
      const measuredAt = 1_700_000_000_000;
      rememberMeasurement('s168a', 'a', { tokens: 42, elapsed_ms: 900 }, measuredAt);
      const { handler } = harness({
        cwd: '/proj',
        dagDir: dir,
        readDagMetrics: () => Promise.resolve({}),
      });

      const first = await invoke(handler, `${ROUTE_PREFIX}/dag?session=s168a`);
      // The answer still carries no metrics: the fallback persists the reading
      // for the *next* answer, it does not publish it out of nowhere.
      expect(first.json()).not.toHaveProperty('metrics');
      const stored = await storedSample('s168a', 'a');
      expect(stored?.tokens).toBe(42);
      // The stored stamp is when the host *measured* the node, not when this
      // request happened to write it.
      expect(stored?.at).toBe(measuredAt);

      // A second poll has nothing left to flush: the sample on disk is byte for
      // byte the one the first request wrote.
      const second = await invoke(handler, `${ROUTE_PREFIX}/dag?session=s168a`);
      expect(second.statusCode).toBe(200);
      expect(await storedSample('s168a', 'a')).toEqual(stored);
    });

    it('writes nothing for a node the host never measured', async () => {
      await seedRunning('s168b');
      const { handler } = harness({
        cwd: '/proj',
        dagDir: dir,
        readDagMetrics: () => Promise.resolve({}),
      });
      const res = await invoke(handler, `${ROUTE_PREFIX}/dag?session=s168b`);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ ok: true, revision: 3 });
      expect(await storedSample('s168b', 'a')).toBeUndefined();
    });

    it('persists a settled node the host can no longer measure', async () => {
      // The host settles a node as soon as its child ends — and by then the
      // child is already out of the registry, so this cached reading is the last
      // one there will ever be. It must land in the document.
      await seed('s168c', '样本 DAG');
      const settled = await updateDag(
        's168c',
        (state) => {
          if (state.state !== 'ok') return { skip: true };
          return applyDagWrite(
            { action: 'set', id: 'a', status: 'done', verdict: 'pass' },
            state.doc,
            's168c',
            '2026-01-02T00:00:00.000Z'
          );
        },
        dir
      );
      expect(settled.ok).toBe(true);
      rememberMeasurement('s168c', 'a', { tokens: 7 }, 1_700_000_000_500);
      const { handler } = harness({
        cwd: '/proj',
        dagDir: dir,
        readDagMetrics: () => Promise.resolve({}),
      });
      await invoke(handler, `${ROUTE_PREFIX}/dag?session=s168c`);
      const stored = await storedSample('s168c', 'a');
      expect(stored?.tokens).toBe(7);
      expect(stored?.at).toBe(1_700_000_000_500);
    });

    it('still answers when the fallback write cannot land', async () => {
      // No document at all: there is nothing to flush and nothing to fail on.
      rememberMeasurement('s168d', 'a', { tokens: 5 });
      const { handler } = harness({
        cwd: '/proj',
        dagDir: dir,
        readDagMetrics: () => Promise.resolve({}),
      });
      const res = await invoke(handler, `${ROUTE_PREFIX}/dag?session=s168d`);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ ok: true, dag: null });
    });
  });

  it('names an unreadable file and keeps answering 200', async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(dagFilePath('s1', dir), '{ nope', 'utf8');
    const { handler } = harness({ cwd: '/proj', dagDir: dir });
    const res = await invoke(handler, `${ROUTE_PREFIX}/dag?session=s1`);
    expect(res.statusCode).toBe(200);
    const payload = res.json();
    expect(payload).toMatchObject({
      ok: true,
      dag: null,
      revision: 0,
      file: dagFilePath('s1', dir),
    });
    expect(payload.warnings as string[]).toEqual([expect.stringContaining('unreadable dag')]);
  });

  it('ignores a document owned by another session', async () => {
    // The route must not serve someone else's graph just because the path it
    // computed happens to exist.
    await seed('s2', '别人的 DAG');
    const { handler } = harness({ cwd: '/proj', dagDir: dir });
    const res = await invoke(handler, `${ROUTE_PREFIX}/dag?session=s1`);
    expect(res.json()).toMatchObject({ ok: true, dag: null });
  });

  it('refuses a session id that could not be a path segment', async () => {
    const { handler } = harness({ cwd: '/proj', dagDir: dir });
    for (const session of ['', '../../etc/passwd', 'a/b', 'x'.repeat(65)]) {
      const res = await invoke(handler, `${ROUTE_PREFIX}/dag?session=${encodeURIComponent(session)}`);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ ok: false });
    }
    // The missing parameter is the empty id, which is equally invalid.
    const missing = await invoke(handler, `${ROUTE_PREFIX}/dag`);
    expect(missing.statusCode).toBe(400);
  });

  it('publishes the mount-line openDagTab switch', async () => {
    const off = harness({ cwd: '/proj', dagDir: dir, openDagTab: false });
    const res = await invoke(off.handler, `${ROUTE_PREFIX}/dag?session=s1`);
    expect(res.json()).toMatchObject({ ok: true, autoOpen: false });
  });

  it('refuses a non-GET like every other route', async () => {
    const { handler } = harness({ cwd: '/proj', dagDir: dir });
    const res = await invoke(handler, `${ROUTE_PREFIX}/dag?session=s1`, 'POST');
    expect(res.statusCode).toBe(405);
    expect(res.headers['allow']).toBe('GET');
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
