import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { activeElapsedMs, nodeMetrics, readDagMetrics, tokenTotal } from './dag-metrics.js';
import { dagFilePath } from './dag-store.js';
import type { DagMetricsInput } from './dag-metrics.js';
import type { DagStatus } from './records.js';
import type { AgentCwdLike, AgentsLike, SessionProjectionsLike } from './types.js';

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

describe('readDagMetrics', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-mint-dag-metrics-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  interface NodeSpec {
    id: string;
    agent?: string;
    status?: DagStatus;
  }

  /** Write a valid document holding `nodes`, in the temp directory. */
  function writeDag(nodes: NodeSpec[]): void {
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

  it('returns nothing without a projection registry, without reading the file', async () => {
    rmSync(dir, { recursive: true, force: true });
    expect(await read({ projections: undefined, agents: agentsFrom({ a: child('a') }) })).toEqual(
      {}
    );
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
});
