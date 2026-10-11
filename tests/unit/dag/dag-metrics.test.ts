import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  activeElapsedMs,
  clearMeasurements,
  contextTokens,
  lastMeasurement,
  measureDagNodes,
  mergeMetrics,
  nodeMetrics,
  readDagMetrics,
  rememberMeasurement,
  sameSampleNumbers,
  sampleNumbersMoved,
  sessionSteps,
  tokenBuckets,
  tokenTotal,
} from '../../../src/dag/dag-metrics.js';
import { dagFilePath } from '../../../src/dag/dag-store.js';
import type { DagDoc, DagSample } from '../../../src/dag/dag.js';
import type { DagMetricsInput, MeasureDagNodesInput } from '../../../src/dag/dag-metrics.js';
import type { DagNodeMetrics, DagNodeView, DagStatus } from '../../../src/shared/records.js';
import type {
  AgentCwdLike,
  AgentsLike,
  SessionProjectionsLike,
} from '../../../src/shared/types.js';

const NOW = '2026-10-07T00:00:00.000Z';
const SESSION = 'session-1';
const SAMPLED_MS = 1_000_000;

/** A full four-bucket state; every case overrides only what it is about. */
function totals(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    uncachedInputTokens: 1,
    outputTokens: 2,
    cacheReadTokens: 3,
    cacheWriteTokens: 4,
    ...over,
  };
}

/** A registry that answers only the keys a case registered. */
function projectionsFor(states: Record<string, unknown>): SessionProjectionsLike {
  return { stateOf: (_session, key) => states[key] };
}

/** A registry keyed by session identity, for the two session shapes. */
function projectionsBySession(
  states: Map<unknown, Record<string, unknown>>
): SessionProjectionsLike {
  return { stateOf: (session, key) => states.get(session)?.[key] };
}

/** Live agents double; values keep whatever shape the case is about. */
function agentsFrom(sessions: Record<string, unknown>): AgentsLike {
  return { get: (id) => sessions[id] as AgentCwdLike | undefined };
}

/** A session object: only its identity matters to the maps above. */
function child(id: string): { id: string } {
  return { id };
}

describe('tokenTotal', () => {
  it('sums the four durable buckets', () => {
    expect(tokenTotal({ totals: totals() })).toBe(10);
  });

  // 契约细节：四个桶都合法地等于 0 是有效读数（0 不是「缺字段」），必须回 0 而不是 undefined。
  // 用 `totals()` 把四个桶全设 0 构造状态，断言 `tokenTotal` 恰好返回 0。
  it('returns 0 when all four buckets are legitimately zero', () => {
    expect(
      tokenTotal({
        totals: totals({
          uncachedInputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        }),
      })
    ).toBe(0);
  });

  it('refuses a state missing any one bucket', () => {
    for (const missing of [
      'uncachedInputTokens',
      'outputTokens',
      'cacheReadTokens',
      'cacheWriteTokens',
    ]) {
      const bucket = { ...totals() } as Record<string, unknown>;
      delete bucket[missing];
      expect(tokenTotal({ totals: bucket }), missing).toBeUndefined();
    }
  });

  it('refuses a bucket that is not a non-negative safe integer', () => {
    for (const bad of [-1, Number.NaN, 1.5, Number.MAX_SAFE_INTEGER + 1, '3', null, undefined]) {
      expect(tokenTotal({ totals: totals({ outputTokens: bad }) }), String(bad)).toBeUndefined();
    }
  });

  it('refuses anything that is not a state object', () => {
    for (const value of [undefined, null, 42, 'x', [], { totals: 3 }, { totals: null }]) {
      expect(tokenTotal(value), JSON.stringify(value)).toBeUndefined();
    }
  });
});

describe('tokenBuckets / sessionSteps', () => {
  // 拆分契约：四桶各自落到线上字段名，顺序固定（面板按这个顺序画那一行）。
  it('maps the four durable buckets onto their wire names', () => {
    expect(tokenBuckets({ totals: totals() })).toEqual({
      uncached_input: 1,
      cache_read: 3,
      cache_write: 4,
      output: 2,
    });
  });

  // 原子性契约：任一桶坏掉，整组不发布——半组合法值会被读成「这一桶就是 0」，那是猜。
  it('refuses the whole group when any one bucket is unusable', () => {
    for (const missing of [
      'uncachedInputTokens',
      'outputTokens',
      'cacheReadTokens',
      'cacheWriteTokens',
    ]) {
      const bucket = { ...totals() } as Record<string, unknown>;
      delete bucket[missing];
      expect(tokenBuckets({ totals: bucket }), missing).toBeUndefined();
      bucket[missing] = -1;
      expect(tokenBuckets({ totals: bucket }), `${missing} negative`).toBeUndefined();
    }
  });

  it('reads the closed-step count off the stats state', () => {
    expect(sessionSteps({ steps: 12, turns: 3 })).toBe(12);
    expect(sessionSteps({ steps: 0 })).toBe(0);
  });

  it('refuses a missing or malformed step count', () => {
    for (const stats of [undefined, null, 42, {}, { steps: -1 }, { steps: 1.5 }, { steps: '3' }]) {
      expect(sessionSteps(stats), JSON.stringify(stats)).toBeUndefined();
    }
  });
});

describe('activeElapsedMs', () => {
  it('returns settledMs alone when no turn is in flight', () => {
    expect(activeElapsedMs({ settledMs: 5 }, 'done', SAMPLED_MS)).toBe(5);
    expect(activeElapsedMs({ settledMs: 5 }, 'running', SAMPLED_MS)).toBe(5);
    expect(activeElapsedMs({ settledMs: 0 }, 'pending', SAMPLED_MS)).toBe(0);
  });

  it('measures a running turn against the sample clock', () => {
    const timing = { settledMs: 100, active: { since: SAMPLED_MS - 250, through: 0 } };
    expect(activeElapsedMs(timing, 'running', SAMPLED_MS)).toBe(350);
  });

  it('measures a settled turn against the through its projection recorded', () => {
    const timing = { settledMs: 100, active: { since: 500, through: 900 } };
    expect(activeElapsedMs(timing, 'done', SAMPLED_MS)).toBe(500);
    expect(activeElapsedMs(timing, 'pending', SAMPLED_MS)).toBe(500);
  });

  // 时间钳制：采样钟早于本 turn 开始时不能算出负数，退回已结算的 `settledMs`。
  // 造 `since = 采样钟 + 250` 的 running 计时，断言结果等于 `settledMs`。
  it('clamps a sample clock that precedes the turn start instead of going negative', () => {
    const timing = { settledMs: 100, active: { since: SAMPLED_MS + 250, through: 0 } };
    expect(activeElapsedMs(timing, 'running', SAMPLED_MS)).toBe(100);
  });

  it('refuses a timing whose settledMs is missing or malformed', () => {
    for (const timing of [
      undefined,
      null,
      'x',
      [],
      {},
      { settledMs: -1 },
      { settledMs: Number.NaN },
      { settledMs: 1.5 },
      { settledMs: '5' },
    ]) {
      expect(activeElapsedMs(timing, 'done', SAMPLED_MS), JSON.stringify(timing)).toBeUndefined();
    }
  });

  it('refuses a settled turn whose active.through is malformed', () => {
    const timing = { settledMs: 100, active: { since: 500, through: Number.NaN } };
    expect(activeElapsedMs(timing, 'done', SAMPLED_MS)).toBeUndefined();
    expect(activeElapsedMs({ settledMs: 100, active: { since: 500 } }, 'done', SAMPLED_MS)).toBe(
      undefined
    );
  });

  it('refuses an active turn whose since is missing or malformed', () => {
    for (const active of [
      {},
      { since: -1 },
      { since: Number.NaN },
      { since: 1.5 },
      { since: '5' },
    ]) {
      const timing = { settledMs: 100, active: { through: 900, ...active } };
      expect(activeElapsedMs(timing, 'done', SAMPLED_MS), JSON.stringify(active)).toBeUndefined();
    }
  });

  it('refuses an active field that is present but not an object', () => {
    for (const active of ['x', 5, true]) {
      expect(
        activeElapsedMs({ settledMs: 100, active }, 'done', SAMPLED_MS),
        JSON.stringify(active)
      ).toBeUndefined();
    }
  });
});

describe('contextTokens', () => {
  // 两个字段不是同一把尺子：provider 报出的最近一次请求大小（窗口口径）优先，
  // `tokenUsage.last` 的三桶之和只是它在别的宿主上的同义替身（输出不计入）。
  it('prefers the provider-reported pressure over the last usage sample', () => {
    expect(
      contextTokens(
        { pressureTokens: 900 },
        { totals: totals(), last: { turn: 1, step: 1, buckets: totals() } }
      )
    ).toBe(900);
  });

  it('falls back to the last usage sample input buckets when pressure is absent', () => {
    expect(
      contextTokens(undefined, { totals: totals(), last: { turn: 1, step: 1, buckets: totals() } })
    ).toBe(8);
  });

  it('falls back when the pressure state is registered but carries no token yet', () => {
    expect(
      contextTokens({}, { totals: totals(), last: { turn: 0, step: 0, buckets: totals() } })
    ).toBe(8);
  });

  // 缺失不猜：两条来源都不成时返回 undefined，绝不把半截输入冒充成上下文占用。
  it('refuses when neither source carries a usable number', () => {
    for (const [pressure, usage] of [
      [undefined, undefined],
      [undefined, { totals: totals() }],
      [undefined, { totals: totals(), last: null }],
      [undefined, { totals: totals(), last: { at: 1 } }],
      [undefined, { totals: totals(), last: { buckets: totals({ cacheReadTokens: -1 }) } }],
      [{ pressureTokens: 1.5 }, undefined],
      [{ pressureTokens: 'x' }, undefined],
    ] as const) {
      expect(contextTokens(pressure, usage), JSON.stringify([pressure, usage])).toBeUndefined();
    }
  });
});

describe('nodeMetrics', () => {
  // 拆分与求和一起发布：`tokens` 是四桶之和（语义不变），四桶分开落，面板才能读成本构成。
  it('publishes the four buckets alongside their sum', () => {
    const projections = projectionsFor({
      tokenUsage: { totals: totals() },
      subagentTiming: { settledMs: 42 },
    });
    expect(
      nodeMetrics({ session: child('a'), projections, status: 'done', sampledMs: SAMPLED_MS })
    ).toEqual({
      tokens: 10,
      uncached_input: 1,
      cache_read: 3,
      cache_write: 4,
      output: 2,
      elapsed_ms: 42,
    });
  });

  it('publishes the step count next to the buckets', () => {
    const projections = projectionsFor({
      tokenUsage: { totals: totals() },
      sessionStats: { steps: 7, turns: 2 },
    });
    expect(
      nodeMetrics({ session: child('a'), projections, status: 'done', sampledMs: SAMPLED_MS })
    ).toEqual({
      tokens: 10,
      uncached_input: 1,
      cache_read: 3,
      cache_write: 4,
      output: 2,
      steps: 7,
    });
  });

  // 缺失不猜：`sessionStats` 没注册时只是不发布 `steps`，四桶与求和照旧。
  it('omits only the step count when the stats key is not registered', () => {
    const projections = projectionsFor({ tokenUsage: { totals: totals() } });
    const found = nodeMetrics({
      session: child('a'),
      projections,
      status: 'done',
      sampledMs: SAMPLED_MS,
    });
    expect(found.steps).toBeUndefined();
    expect(found).toEqual({
      tokens: 10,
      uncached_input: 1,
      cache_read: 3,
      cache_write: 4,
      output: 2,
    });
  });

  // 桶坏了就整组不发：`elapsed_ms` 与 `steps` 是另两次读，不该被连累。
  it('omits the whole bucket group when one bucket is unusable', () => {
    const projections = projectionsFor({
      tokenUsage: { totals: totals({ cacheReadTokens: 1.5 }) },
      sessionStats: { steps: 4 },
      subagentTiming: { settledMs: 42 },
    });
    expect(
      nodeMetrics({ session: child('a'), projections, status: 'done', sampledMs: SAMPLED_MS })
    ).toEqual({ steps: 4, elapsed_ms: 42 });
  });

  it('returns nothing when neither key is registered', () => {
    const projections = projectionsFor({});
    expect(
      nodeMetrics({ session: child('a'), projections, status: 'done', sampledMs: SAMPLED_MS })
    ).toEqual({});
  });

  // 降级契约：宿主状态查询抛错时只能当作没读数，绝不把异常抛给调用方。
  // 用一个 `stateOf` 直接抛错的投影服务，断言 `nodeMetrics` 返回空对象。
  it('returns nothing when the registry throws', () => {
    const projections: SessionProjectionsLike = {
      stateOf: () => {
        throw new Error('unknown session');
      },
    };
    expect(
      nodeMetrics({ session: child('a'), projections, status: 'done', sampledMs: SAMPLED_MS })
    ).toEqual({});
  });

  // 上下文占用是独立的一次读：`contextPressure` 没注册只丢 `context`，四桶/步数/时长照旧。
  it('publishes the context occupancy next to the buckets', () => {
    const projections = projectionsFor({
      tokenUsage: { totals: totals() },
      contextPressure: { pressureTokens: 900 },
      subagentTiming: { settledMs: 42 },
    });
    expect(
      nodeMetrics({ session: child('a'), projections, status: 'done', sampledMs: SAMPLED_MS })
    ).toEqual({
      tokens: 10,
      uncached_input: 1,
      cache_read: 3,
      cache_write: 4,
      output: 2,
      context: 900,
      elapsed_ms: 42,
    });
  });

  it('omits only the context when the pressure key is not registered', () => {
    const projections = projectionsFor({
      tokenUsage: { totals: totals() },
      sessionStats: { steps: 7 },
    });
    const found = nodeMetrics({
      session: child('a'),
      projections,
      status: 'done',
      sampledMs: SAMPLED_MS,
    });
    expect(found.context).toBeUndefined();
    expect(found.steps).toBe(7);
    expect(found.tokens).toBe(10);
  });

  // main 口径：整条主会话的累计不是「这个节点花了多少」，故求和与四桶都不发；
  // 上下文占用与步数、时长是全会话可比的量，照发。
  it('withholds the token counts for the main session but keeps context and time', () => {
    const projections = projectionsFor({
      tokenUsage: { totals: totals() },
      contextPressure: { pressureTokens: 900 },
      sessionStats: { steps: 7 },
      subagentTiming: { settledMs: 42 },
    });
    expect(
      nodeMetrics({
        session: child('a'),
        projections,
        status: 'running',
        sampledMs: SAMPLED_MS,
        kind: 'main',
      })
    ).toEqual({ context: 900, steps: 7, elapsed_ms: 42 });
  });
});

describe('mergeMetrics', () => {
  /** One document node; a merge only reads its id. */
  function view(id: string): DagNodeView {
    return {
      id,
      label: id.slice(0, 6),
      title: `node ${id}`,
      phase: 'exec',
      status: 'done',
      depends_on: [],
      updated_at: NOW,
    };
  }

  const nodes = [view('a'), view('b'), view('c')];

  // 优先级契约：活读数压过落盘样本，且输出的活读数不带 `at`（它不是某次持久化的戳）。
  // 同一个 id 同时给 `live` 与 `stored`，断言合并结果取 live 且键只有 tokens/elapsed_ms。
  it('prefers the live measurement, which carries no `at` of its own', () => {
    const merged = mergeMetrics({
      live: { a: { tokens: 1, elapsed_ms: 2, at: 99 } },
      stored: { a: { tokens: 9, elapsed_ms: 9, at: 7 } },
      nodes,
    });
    expect(merged).toEqual({ a: { tokens: 1, elapsed_ms: 2 } });
    expect(Object.keys(merged['a'] ?? {})).toEqual(['tokens', 'elapsed_ms']);
  });

  it('falls back to the stored sample, stamped with the `at` it was persisted at', () => {
    expect(
      mergeMetrics({
        live: { a: { tokens: 1 } },
        stored: { b: { tokens: 8, at: 7 }, c: { elapsed_ms: 6, at: 5 } },
        nodes,
      })
    ).toEqual({ a: { tokens: 1 }, b: { tokens: 8, at: 7 }, c: { elapsed_ms: 6, at: 5 } });
  });

  it('does not answer an id the document no longer declares', () => {
    expect(
      mergeMetrics({
        live: { ghost: { tokens: 1 } },
        stored: { ghost: { tokens: 2, at: 3 } },
        nodes,
      })
    ).toEqual({});
  });

  it('drops a stored entry with nothing trustworthy left', () => {
    expect(
      mergeMetrics({
        live: {},
        stored: { a: { tokens: -1, at: 3 }, b: { at: 3 }, c: { elapsed_ms: 4, at: 5 } },
        nodes,
      })
    ).toEqual({ c: { elapsed_ms: 4, at: 5 } });
  });

  it('answers nothing when there is neither a live nor a stored measurement', () => {
    expect(mergeMetrics({ live: {}, stored: undefined, nodes })).toEqual({});
    expect(mergeMetrics({ live: {}, stored: {}, nodes })).toEqual({});
    expect(mergeMetrics({ live: {}, stored: undefined, nodes: [] })).toEqual({});
  });
});

describe('reading DAG metrics', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-mint-dag-metrics-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    // The measurement cache is module-level, so one case's remembered reading
    // would otherwise answer a later case's route read (the merge falls back to
    // it, by design).
    clearMeasurements();
  });

  interface NodeSpec {
    id: string;
    agent?: string;
    status?: DagStatus;
  }

  /** Write a valid document holding `nodes` and, when a case gives them, `samples`. */
  function writeDag(nodes: NodeSpec[], samples?: Record<string, DagSample>): void {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      dagFilePath(SESSION, dir),
      JSON.stringify({
        version: 1,
        session: SESSION,
        title: '',
        revision: 1,
        created_at: NOW,
        updated_at: NOW,
        nodes: nodes.map((spec) => ({
          id: spec.id,
          label: spec.id.slice(0, 6),
          title: `node ${spec.id}`,
          phase: 'exec',
          status: spec.status ?? 'done',
          depends_on: [],
          updated_at: NOW,
          ...(spec.agent === undefined ? {} : { agent: spec.agent }),
        })),
        edges: [],
        ...(samples === undefined ? {} : { samples }),
      }),
      'utf8'
    );
  }

  /** One read over the temp directory, with every host service a case supplies. */
  function read(over: Partial<DagMetricsInput> = {}): Promise<Record<string, unknown>> {
    return readDagMetrics({
      sessionId: SESSION,
      dagDir: dir,
      agents: undefined,
      projections: undefined,
      sampledMs: SAMPLED_MS,
      ...over,
    });
  }

  it('returns nothing without a projection registry and without a file to fall back to', async () => {
    rmSync(dir, { recursive: true, force: true });
    expect(await read({ projections: undefined, agents: agentsFrom({ a: child('a') }) })).toEqual(
      {}
    );
  });

  it('falls back to a stored sample even without a projection registry', async () => {
    writeDag([{ id: 'a', agent: 'child-a' }], { a: { tokens: 9, at: 5 } });
    expect(
      await read({ projections: undefined, agents: agentsFrom({ 'child-a': child('a') }) })
    ).toEqual({ a: { tokens: 9, at: 5 } });
  });

  it('returns nothing when the document is missing', async () => {
    expect(await read({ projections: projectionsFor({}) })).toEqual({});
  });

  it('returns nothing when the document cannot be read', async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(dagFilePath(SESSION, dir), 'not json', 'utf8');
    expect(await read({ projections: projectionsFor({}) })).toEqual({});
  });

  it('returns nothing when the document holds no node', async () => {
    writeDag([]);
    expect(await read({ projections: projectionsFor({}) })).toEqual({});
  });

  it('does not query agents for nodes that carry no agent', async () => {
    writeDag([{ id: 'a' }, { id: 'b' }]);
    const get = vi.fn(() => undefined);
    const agents: AgentsLike = { get };
    expect(await read({ projections: projectionsFor({}), agents })).toEqual({});
    expect(get).not.toHaveBeenCalled();
  });

  it('returns nothing when the composition has no agents service', async () => {
    writeDag([{ id: 'a', agent: 'child-a' }]);
    expect(await read({ projections: projectionsFor({}), agents: undefined })).toEqual({});
  });

  it('reads both session shapes and only the fields that are real', async () => {
    writeDag([
      { id: 'a', agent: 'child-a' },
      { id: 'b', agent: 'child-b' },
      { id: 'c', agent: 'child-c', status: 'running' },
      { id: 'd', agent: 'child-d' },
    ]);
    const a = child('a');
    const b = child('b');
    const c = child('c');
    const d = child('d');
    const agents = agentsFrom({
      // The wrapper shape.
      'child-a': { session: a },
      // The bare session shape.
      'child-b': b,
      'child-c': { session: c },
      // An agent whose session the host cannot resolve.
      'child-d': {},
    });
    const projections = projectionsBySession(
      new Map<unknown, Record<string, unknown>>([
        [a, { tokenUsage: { totals: totals() }, subagentTiming: { settledMs: 7 } }],
        [b, { subagentTiming: { settledMs: 8 } }],
        [
          c,
          {
            tokenUsage: { totals: totals() },
            subagentTiming: { settledMs: 9, active: { since: SAMPLED_MS - 3, through: 0 } },
          },
        ],
        [d, { tokenUsage: { totals: { outputTokens: 1 } } }],
      ])
    );
    const found = await read({ projections, agents });
    expect(found).toEqual({
      a: {
        tokens: 10,
        uncached_input: 1,
        cache_read: 3,
        cache_write: 4,
        output: 2,
        elapsed_ms: 7,
      },
      b: { elapsed_ms: 8 },
      c: {
        tokens: 10,
        uncached_input: 1,
        cache_read: 3,
        cache_write: 4,
        output: 2,
        elapsed_ms: 12,
      },
    });
  });

  it('skips a node whose agent resolves to no session', async () => {
    writeDag([{ id: 'a', agent: 'child-a' }]);
    const agents: AgentsLike = { get: () => undefined };
    const projections = projectionsFor({ tokenUsage: { totals: totals() } });
    expect(await read({ projections, agents })).toEqual({});
  });

  // 形状不变量：节点级指标里不能出现值为 undefined 的字段（可选字段要么有值要么没有键）。
  // 一条读数合法、一条两个字段都非法，断言结果只剩前者且键集合只有 `tokens`。
  it('keeps every node key free of undefined-valued fields', async () => {
    writeDag([
      { id: 'a', agent: 'child-a' },
      { id: 'b', agent: 'child-b' },
    ]);
    const a = child('a');
    const b = child('b');
    const agents = agentsFrom({ 'child-a': { session: a }, 'child-b': b });
    const projections = projectionsBySession(
      new Map<unknown, Record<string, unknown>>([
        [a, { tokenUsage: { totals: totals() } }],
        [
          b,
          {
            tokenUsage: { totals: { outputTokens: -1 } },
            subagentTiming: { settledMs: Number.NaN },
          },
        ],
      ])
    );
    const found = await read({ projections, agents });
    expect(Object.keys(found)).toEqual(['a']);
    expect(Object.keys(found['a'] ?? {})).toEqual([
      'tokens',
      'uncached_input',
      'cache_read',
      'cache_write',
      'output',
    ]);
  });

  describe('measureDagNodes', () => {
    /** One measure over the temp directory, with every host service a case supplies. */
    function measure(
      over: Partial<MeasureDagNodesInput> = {}
    ): Promise<{ metrics: Record<string, DagNodeMetrics>; doc: DagDoc | undefined }> {
      return measureDagNodes({
        sessionId: SESSION,
        dagDir: dir,
        agents: undefined,
        projections: undefined,
        sampledMs: SAMPLED_MS,
        ...over,
      });
    }

    it('answers no document and no metric when the file is missing', async () => {
      expect(await measure()).toEqual({ metrics: {}, doc: undefined });
    });

    it('answers the document it read, even when nothing could be measured', async () => {
      writeDag([{ id: 'a' }]);
      const { metrics, doc } = await measure();
      expect(metrics).toEqual({});
      expect(doc?.nodes.map((node) => node.id)).toEqual(['a']);
    });

    it('falls back to the stored sample when the composition has no projections', async () => {
      writeDag([{ id: 'a', agent: 'child-a' }], { a: { tokens: 9, at: 5 } });
      const { metrics } = await measure({ agents: agentsFrom({ 'child-a': child('a') }) });
      expect(metrics).toEqual({ a: { tokens: 9, at: 5 } });
    });

    it('falls back to the stored sample for a node whose child session is gone', async () => {
      writeDag([{ id: 'a', agent: 'child-a' }], { a: { elapsed_ms: 4, at: 5 } });
      const { metrics } = await measure({
        agents: agentsFrom({}),
        projections: projectionsFor({}),
      });
      expect(metrics).toEqual({ a: { elapsed_ms: 4, at: 5 } });
    });

    it('prefers a live measurement over the stored sample', async () => {
      writeDag([{ id: 'a', agent: 'child-a' }], { a: { tokens: 9, at: 5 } });
      const a = child('a');
      const agents = agentsFrom({ 'child-a': { session: a } });
      const projections = projectionsBySession(
        new Map<unknown, Record<string, unknown>>([[a, { tokenUsage: { totals: totals() } }]])
      );
      expect((await measure({ agents, projections })).metrics).toEqual({
        a: {
          tokens: 10,
          uncached_input: 1,
          cache_read: 3,
          cache_write: 4,
          output: 2,
        },
      });
    });

    it('answers nothing for a node with neither an agent nor a stored sample', async () => {
      writeDag([{ id: 'a' }, { id: 'b', agent: 'child-b' }], { b: { tokens: 2, at: 3 } });
      const { metrics } = await measure({
        agents: agentsFrom({}),
        projections: projectionsFor({}),
      });
      expect(Object.keys(metrics)).toEqual(['b']);
    });
  });
});

describe('sample comparison', () => {
  const base: DagSample = {
    tokens: 10,
    uncached_input: 1,
    cache_read: 3,
    cache_write: 4,
    output: 2,
    steps: 5,
    at: 7,
  };

  // 逐字段全等：六个计数字段任一不同就不是同一份读数（节流据此决定要不要落盘）。
  it('calls two samples equal only when every count agrees', () => {
    expect(sameSampleNumbers(base, { ...base })).toBe(true);
    for (const field of [
      'tokens',
      'uncached_input',
      'cache_read',
      'cache_write',
      'output',
      'steps',
    ] as const) {
      expect(sameSampleNumbers(base, { ...base, [field]: 99 }), field).toBe(false);
    }
    expect(sameSampleNumbers(base, { ...base, elapsed_ms: 1 })).toBe(false);
  });

  // `at` 是落库戳而不是计数：同一个数换个戳仍是同一份读数。
  it('treats `at` as its own axis rather than a count', () => {
    expect(sameSampleNumbers(base, { ...base, at: 8 })).toBe(true);
  });

  it('counts a moved bucket or step as movement', () => {
    expect(sampleNumbersMoved(base, { ...base })).toBe(false);
    expect(sampleNumbersMoved(base, { ...base, cache_read: 99 })).toBe(true);
    expect(sampleNumbersMoved(base, { ...base, steps: 6 })).toBe(true);
    // 时长由写节流阈值单独把关，这里的「动」不含它。
    expect(sampleNumbersMoved(base, { ...base, elapsed_ms: 99 })).toBe(false);
  });

  it('reads a newly measured field as movement, an absent one as none', () => {
    expect(sampleNumbersMoved(base, { tokens: 10, at: 7 })).toBe(false);
    expect(sampleNumbersMoved({ tokens: 10, at: 7 }, base)).toBe(true);
  });
});

describe('the measurement cache', () => {
  afterEach(() => {
    clearMeasurements();
  });

  it('remembers a measurement and answers it back per session and node', () => {
    rememberMeasurement(SESSION, 'a', { tokens: 1, elapsed_ms: 2 }, 500);
    // The stamp travels with the numbers: a sample persisted later must carry
    // when it was *measured*, not when it was written.
    expect(lastMeasurement(SESSION, 'a')).toEqual({ tokens: 1, elapsed_ms: 2, at: 500 });
    expect(lastMeasurement(SESSION, 'b')).toBeUndefined();
    expect(lastMeasurement('session-2', 'a')).toBeUndefined();
  });

  it('ignores a reading with nothing usable in it', () => {
    rememberMeasurement(SESSION, 'a', {});
    rememberMeasurement(SESSION, 'b', { tokens: -1 });
    rememberMeasurement(SESSION, 'c', { elapsed_ms: 1.5 });
    for (const id of ['a', 'b', 'c']) expect(lastMeasurement(SESSION, id), id).toBeUndefined();
  });

  it('keeps exactly what a stored sample would accept', () => {
    rememberMeasurement(SESSION, 'a', { tokens: 1, elapsed_ms: 2, at: 99 }, 7);
    // `at` is the caller's stamp, never the one a mapping carried in.
    expect(lastMeasurement(SESSION, 'a')).toEqual({ tokens: 1, elapsed_ms: 2, at: 7 });
    rememberMeasurement(SESSION, 'b', { tokens: Number.NaN, elapsed_ms: 3 }, 8);
    expect(lastMeasurement(SESSION, 'b')).toEqual({ elapsed_ms: 3, at: 8 });
  });

  // 白名单同步：内存缓存也要留住四桶与步数，否则后到的读者落盘时会把它们丢掉。
  it('keeps the four buckets and the step count in the memory too', () => {
    rememberMeasurement(
      SESSION,
      'a',
      { uncached_input: 1, cache_read: 2, cache_write: 3, output: 4, steps: 5 },
      7
    );
    expect(lastMeasurement(SESSION, 'a')).toEqual({
      uncached_input: 1,
      cache_read: 2,
      cache_write: 3,
      output: 4,
      steps: 5,
      at: 7,
    });
  });

  // 缓存容量边界：每会话只留最近 200 条，第 201 条落进来必须把最旧的挤掉。
  // 连续写入 201 个节点，断言 `n0` 已消失而 `n1`、`n200` 仍在。
  it('evicts the oldest entry once a session holds the 200 most recent', () => {
    for (let index = 0; index <= 200; index += 1) {
      rememberMeasurement(SESSION, `n${String(index)}`, { tokens: index });
    }
    expect(lastMeasurement(SESSION, 'n0')).toBeUndefined();
    expect(lastMeasurement(SESSION, 'n1')?.tokens).toBe(1);
    expect(lastMeasurement(SESSION, 'n200')?.tokens).toBe(200);
  });

  it('re-remembering a node makes it the newest instead of a second entry', () => {
    for (let index = 0; index < 200; index += 1) {
      rememberMeasurement(SESSION, `n${String(index)}`, { tokens: 1 });
    }
    rememberMeasurement(SESSION, 'n0', { tokens: 2 });
    rememberMeasurement(SESSION, 'n201', { tokens: 1 });
    expect(lastMeasurement(SESSION, 'n0')?.tokens).toBe(2);
    expect(lastMeasurement(SESSION, 'n1')).toBeUndefined();
  });

  it('clears one session, or everything, as the seam is asked to', () => {
    rememberMeasurement(SESSION, 'a', { tokens: 1 });
    rememberMeasurement('session-2', 'a', { tokens: 1 });
    clearMeasurements(SESSION);
    expect(lastMeasurement(SESSION, 'a')).toBeUndefined();
    expect(lastMeasurement('session-2', 'a')?.tokens).toBe(1);
    clearMeasurements();
    expect(lastMeasurement('session-2', 'a')).toBeUndefined();
  });

  // 回归钉：`lastMeasurement` 必须返回副本，调用方改它不能污染缓存里的活读数。
  // 取回读数后直接改写 `at` 与 `tokens`，再读一次断言仍是原值。
  it('answers a copy, so a caller cannot stamp the remembered live reading', () => {
    rememberMeasurement(SESSION, 'a', { tokens: 1 }, 5);
    const found = lastMeasurement(SESSION, 'a');
    if (found === undefined) throw new Error('expected a remembered measurement');
    found.at = 123;
    found.tokens = 9;
    expect(lastMeasurement(SESSION, 'a')).toEqual({ tokens: 1, at: 5 });
  });
});
