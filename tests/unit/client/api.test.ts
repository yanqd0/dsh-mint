import { describe, expect, it } from 'vitest';

import { apiPath, createApi, queryString } from '../../../src/client/api.js';

/** One recorded request. */
interface Call {
  url: string;
  method: string | undefined;
  signal: AbortSignal | null | undefined;
}

/** Build a fetch double answering with `body` and `status`. */
function fetchStub(
  body: string,
  status = 200,
  calls: Call[] = []
): typeof globalThis.fetch {
  return (input, init) => {
    calls.push({
      url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      method: init?.method,
      signal: init?.signal,
    });
    return Promise.resolve(new Response(body, { status }));
  };
}

describe('apiPath', () => {
  it('resolves against the page directory, not the origin', () => {
    expect(apiPath('/dsh-mint/issues', 'http://host/app/')).toBe('/app/dsh-mint/issues');
    expect(apiPath('dsh-mint/issues', 'http://host/app/')).toBe('/app/dsh-mint/issues');
    expect(apiPath('/dsh-mint/issues', 'http://host/')).toBe('/dsh-mint/issues');
  });

  it('falls back to the origin outside a browser', () => {
    expect(apiPath('/dsh-mint/issues')).toBe('/dsh-mint/issues');
  });
});

describe('queryString', () => {
  it('drops empty and undefined values and escapes the rest', () => {
    expect(queryString({ a: '1', b: undefined, c: '' })).toBe('?a=1');
    expect(queryString({ search: '面板 x' })).toBe('?search=%E9%9D%A2%E6%9D%BF+x');
    expect(queryString({})).toBe('');
  });
});

describe('createApi', () => {
  it('addresses the session routes with the mount point and the query', async () => {
    const calls: Call[] = [];
    const api = createApi({
      sessionId: 's1',
      baseUri: 'http://host/app/',
      fetch: fetchStub(JSON.stringify({ ok: true, items: [], page: 1, page_size: 20, pages: 0, total: 0 }), 200, calls),
    });
    const result = await api.issues({ status: 'open', search: 'x' });
    expect(result.ok).toBe(true);
    expect(calls[0]?.url).toBe('/app/dsh-mint/issues?session=s1&status=open&search=x');
    expect(calls[0]?.method).toBe('GET');
  });

  it('forwards the abort signal and the container list query', async () => {
    const calls: Call[] = [];
    const controller = new AbortController();
    const api = createApi({
      sessionId: 's1',
      baseUri: 'http://host/',
      fetch: fetchStub('{"ok":true,"items":[],"page":1,"page_size":20,"pages":0,"total":0}', 200, calls),
    });
    await api.milestones({ page: '2', pageSize: '10', allStates: '1' }, controller.signal);
    expect(calls[0]?.signal).toBe(controller.signal);
    expect(calls[0]?.url).toBe('/dsh-mint/milestones?session=s1&page=2&pageSize=10&allStates=1');
  });

  it('passes a failure envelope through untouched', async () => {
    const api = createApi({
      sessionId: 's1',
      baseUri: 'http://host/',
      fetch: fetchStub(JSON.stringify({ ok: false, error: 'session-not-live' }), 400),
    });
    expect(await api.issues({})).toEqual({ ok: false, error: 'session-not-live' });
  });

  it('reports a non-JSON body with its status instead of throwing', async () => {
    const api = createApi({
      sessionId: 's1',
      baseUri: 'http://host/',
      fetch: fetchStub('<html>nope</html>', 502),
    });
    const result = await api.issue(9);
    expect(result).toEqual({ ok: false, error: 'HTTP 502: <html>nope</html>' });
  });

  it('reports a transport failure as an error payload', async () => {
    const api = createApi({
      sessionId: 's1',
      baseUri: 'http://host/',
      fetch: () => Promise.reject(new Error('network down')),
    });
    expect(await api.plan(3)).toEqual({ ok: false, error: 'network down' });
  });

  it('addresses detail and body routes by id', async () => {
    const calls: Call[] = [];
    const api = createApi({
      sessionId: 's7',
      baseUri: 'http://host/',
      fetch: fetchStub('{"ok":true,"item":{},"truncated":false}', 200, calls),
    });
    await api.issue(42);
    await api.milestone(2);
    expect(calls.map((call) => call.url)).toEqual([
      '/dsh-mint/issue?session=s7&id=42',
      '/dsh-mint/milestone?session=s7&id=2',
    ]);
  });

  it('reads the lookup tables from one parameterless route', async () => {
    const calls: Call[] = [];
    const api = createApi({
      sessionId: 's1',
      baseUri: 'http://host/app/',
      fetch: fetchStub('{"ok":true,"plans":[],"milestones":[],"labels":[]}', 200, calls),
    });
    const result = await api.meta();
    expect(result.ok).toBe(true);
    expect(calls[0]?.url).toBe('/app/dsh-mint/meta?session=s1');

    // 面板自己的刷新也只是「重读字典」：路由每次都答同样三次读，没有额外参数
    //（placement 记忆化与它的 `refresh=1` 已退掉）。
    await api.meta(undefined);
    expect(calls[1]?.url).toBe('/app/dsh-mint/meta?session=s1');
  });

  it('reads the DAG by session alone', async () => {
    const calls: Call[] = [];
    const controller = new AbortController();
    const body =
      '{"ok":true,"dag":null,"revision":0,"file":"/tmp/mint/dag/s1.json","autoOpen":true}';
    const api = createApi({
      sessionId: 's1',
      baseUri: 'http://host/app/',
      fetch: fetchStub(body, 200, calls),
    });
    await api.dag(controller.signal);
    // The route is the only one keyed by the session file rather than a project,
    // so nothing but the session travels in the query.
    expect(calls[0]?.url).toBe('/app/dsh-mint/dag?session=s1');
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.signal).toBe(controller.signal);
  });

  it('reports a refused DAG read as a failure envelope', async () => {
    const api = createApi({
      sessionId: '../etc',
      baseUri: 'http://host/',
      fetch: fetchStub('{"ok":false,"error":"invalid session"}', 400),
    });
    expect(await api.dag()).toEqual({ ok: false, error: 'invalid session' });
  });
});
