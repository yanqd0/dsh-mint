import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  activeElapsedMs,
  clearMeasurements,
  lastMeasurement,
  measureDagNodes,
  mergeMetrics,
  nodeMetrics,
  readDagMetrics,
  rememberMeasurement,
  tokenTotal,
} from '../../../src/dag/dag-metrics.js';
import { dagFilePath } from '../../../src/dag/dag-store.js';
import type { DagDoc, DagSample } from '../../../src/dag/dag.js';
import type { DagMetricsInput, MeasureDagNodesInput } from '../../../src/dag/dag-metrics.js';
import type { DagNodeMetrics, DagNodeView, DagStatus } from '../../../src/shared/records.js';
import type { AgentCwdLike, AgentsLike, SessionProjectionsLike } from '../../../src/shared/types.js';

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

describe('nodeMetrics', () => {
  it('reads both fields when both keys are registered', () => {
    const projections = projectionsFor({
      tokenUsage: { totals: totals() },
      subagentTiming: { settledMs: 42 },
    });
    expect(
      nodeMetrics({ session: child('a'), projections, status: 'done', sampledMs: SAMPLED_MS })
    ).toEqual({ tokens: 10, elapsed_ms: 42 });
  });

  it('exposes only tokens when the timing key is not registered', () => {
    const projections = projectionsFor({ tokenUsage: { totals: totals() } });
    const found = nodeMetrics({
      session: child('a'),
      projections,
      status: 'done',
      sampledMs: SAMPLED_MS,
    });
    expect(Object.keys(found)).toEqual(['tokens']);
    expect(found).toEqual({ tokens: 10 });
  });

  it('returns nothing when neither key is registered', () => {
    const projections = projectionsFor({});
    expect(
      nodeMetrics({ session: child('a'), projections, status: 'done', sampledMs: SAMPLED_MS })
    ).toEqual({});
  });

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
      a: { tokens: 10, elapsed_ms: 7 },
      b: { elapsed_ms: 8 },
      c: { tokens: 10, elapsed_ms: 12 },
    });
  });

  it('skips a node whose agent resolves to no session', async () => {
    writeDag([{ id: 'a', agent: 'child-a' }]);
    const agents: AgentsLike = { get: () => undefined };
    const projections = projectionsFor({ tokenUsage: { totals: totals() } });
    expect(await read({ projections, agents })).toEqual({});
  });

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
    expect(Object.keys(found['a'] ?? {})).toEqual(['tokens']);
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
      expect((await measure({ agents, projections })).metrics).toEqual({ a: { tokens: 10 } });
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

  it('answers a copy, so a caller cannot stamp the remembered live reading', () => {
    rememberMeasurement(SESSION, 'a', { tokens: 1 }, 5);
    const found = lastMeasurement(SESSION, 'a');
    if (found === undefined) throw new Error('expected a remembered measurement');
    found.at = 123;
    found.tokens = 9;
    expect(lastMeasurement(SESSION, 'a')).toEqual({ tokens: 1, at: 5 });
  });
});
