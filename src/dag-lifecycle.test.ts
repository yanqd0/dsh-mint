import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { clearMeasurements, lastMeasurement } from './dag-metrics.js';
import { readDag, updateDag } from './dag-store.js';
import { installDagLifecycle } from './dag-lifecycle.js';
import type { DagRead } from './dag-store.js';
import type { DagNodeView } from './records.js';
import type { DshContext } from './types.js';

/**
 * The host's subagent ↔ DAG node pairing (plan #31), and the sample it persists
 * on `subagent/end` (#168).
 *
 * Every case runs against a **temporary directory**: the shipped default is
 * `/tmp/mint/dag`, and a test that wrote there would delete a real session's
 * graph (or, worse, pass because of one). The listeners are fire-and-forget, so
 * each case drains the microtask/macrotask queue (which is what both queued
 * writes need) and then reads the document back through the real store — which
 * is also the only way to prove the two writes did not clobber each other.
 */
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-mint-dag-lifecycle-'));
});

afterEach(() => {
  clearMeasurements();
  rmSync(dir, { recursive: true, force: true });
});

const SESSION = 'root';
const AGENT = 'child';

interface EndInfo {
  runId: string;
  id: string;
  stopReason?: string;
  lastAssistantMessage?: readonly unknown[];
}

interface Harness {
  start: (info: { runId: string; id: string }) => void;
  end: (info: EndInfo) => void;
  /** Who the agent registry names as a session's parent, per session id. */
  parents: Map<string, string>;
  /** The projection states, per session id. */
  states: Map<string, Record<string, unknown>>;
  /** Drop the `sessionProjections` service, as a lean composition has none. */
  withoutProjections: () => void;
}

/**
 * A captured-listener context whose three host lookups are independent, so
 * "no parent", "no session" and "no measurement" are separable failures.
 */
function harness(): Harness {
  const listeners: Record<string, (info: never) => void> = {};
  const parents = new Map<string, string>();
  const states = new Map<string, Record<string, unknown>>();
  let projections = true;
  const ctx: DshContext = {
    on: (event, listener) => {
      listeners[event] = listener as (info: never) => void;
      return () => {};
    },
    get: (name) => {
      if (name === 'agents') {
        return {
          get: (id: string) => {
            const parent = parents.get(id);
            return {
              id,
              session: { id, header: parent === undefined ? {} : { parentSession: parent } },
            };
          },
        };
      }
      if (name === 'sessionProjections' && projections) {
        return {
          stateOf: (session: unknown, key: string): unknown =>
            states.get((session as { id?: string }).id ?? '')?.[key],
        };
      }
      return undefined;
    },
  };
  installDagLifecycle(ctx, dir);
  return {
    start: (info) => listeners['subagent/start']?.(info as never),
    end: (info) => listeners['subagent/end']?.(info as never),
    parents,
    states,
    withoutProjections: () => {
      projections = false;
    },
  };
}

/** The two projection states the measurement really reads, under one child. */
function measurable(events: Harness, id = AGENT): void {
  events.states.set(id, {
    // The registry is keyed by the projection's own name, not by ours.
    tokenUsage: {
      totals: {
        uncachedInputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 3,
        cacheWriteTokens: 1,
      },
    },
    subagentTiming: { settledMs: 0, active: { since: 0, through: 0 } },
  });
}

/** One document with a single node, written through the real store. */
async function seedNode(
  session: string,
  node: Omit<DagNodeView, 'depends_on' | 'updated_at'>
): Promise<void> {
  const update = await updateDag(
    session,
    () => ({
      doc: {
        version: 1 as const,
        session,
        title: 'DAG',
        revision: 1,
        created_at: 'T',
        updated_at: 'T',
        nodes: [{ depends_on: [], updated_at: 'T', ...node }],
        edges: [],
      },
    }),
    dir
  );
  expect(update.ok).toBe(true);
}

/** A running node already paired with {@link AGENT}, as `start` would leave it. */
const PAIRED_NODE = {
  id: 'a',
  label: '总①',
  title: 't',
  phase: 'exec',
  status: 'running',
  agent: AGENT,
} as const;

/** Let both queued writes (`samples`, then the settlement) run to completion. */
async function drain(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function stored(session = SESSION): Promise<DagRead> {
  return readDag(session, dir);
}

describe('subagent/end persists a sample (#168)', () => {
  it('merges the measured sample under its node id, with an `at`', async () => {
    await seedNode(SESSION, PAIRED_NODE);
    const events = harness();
    measurable(events);
    events.parents.set(AGENT, SESSION);

    const before = Date.now();
    events.end({ runId: 'r1', id: AGENT, stopReason: 'error' });
    await drain();
    const after = Date.now();

    const read = await stored();
    expect(read.state).toBe('ok');
    if (read.state !== 'ok') return;
    const sample = read.doc.samples?.['a'];
    expect(sample).toBeDefined();
    expect(typeof sample?.at).toBe('number');
    // The four buckets of the fixture, summed by the host's own reader.
    expect(sample?.tokens).toBe(124);
    expect(sample?.elapsed_ms).toBeGreaterThanOrEqual(0);
    // `at` is the sample clock the reading was taken at, not the write's time.
    expect(sample?.at).toBeGreaterThanOrEqual(before);
    expect(sample?.at).toBeLessThanOrEqual(after);
  });

  it('writes `samples` as its own change, before the settlement that follows', async () => {
    await seedNode(SESSION, PAIRED_NODE);
    const events = harness();
    measurable(events);
    events.parents.set(AGENT, SESSION);

    events.end({ runId: 'r1', id: AGENT, stopReason: 'error' });
    await drain();

    const read = await stored();
    expect(read.state).toBe('ok');
    if (read.state !== 'ok') return;
    // Two writes, two revisions: a sample that were part of the settlement would
    // only have moved the revision once.
    expect(read.doc.revision).toBe(3);
    // And the sample step left the node exactly as it was — the settlement is
    // what wrote `status`, `verdict` and `updated_at`.
    expect(read.doc.nodes[0]).toMatchObject({ id: 'a', status: 'done', verdict: 'fail' });
  });

  it('leaves the node untouched when it was already settled', async () => {
    await seedNode(SESSION, { ...PAIRED_NODE, status: 'done', verdict: 'pass' });
    const events = harness();
    measurable(events);
    events.parents.set(AGENT, SESSION);

    events.end({ runId: 'r1', id: AGENT, stopReason: 'error' });
    await drain();

    const read = await stored();
    expect(read.state).toBe('ok');
    if (read.state !== 'ok') return;
    // `settleNode` only touches a `running` node, so the one write here is the
    // sample: the child's own verdict survives the backstop.
    expect(read.doc.revision).toBe(2);
    expect(read.doc.nodes[0]).toMatchObject({ status: 'done', verdict: 'pass' });
    expect(read.doc.samples?.['a']?.tokens).toBe(124);
  });

  it('remembers the reading, so a later reader can persist it without the child', async () => {
    await seedNode(SESSION, PAIRED_NODE);
    const events = harness();
    measurable(events);
    events.parents.set(AGENT, SESSION);

    events.end({ runId: 'r1', id: AGENT, stopReason: 'error' });
    await drain();

    const remembered = lastMeasurement(SESSION, 'a');
    expect(remembered?.tokens).toBe(124);
    expect(typeof remembered?.elapsed_ms).toBe('number');
  });

  it('writes nothing when the host cannot measure the child', async () => {
    await seedNode(SESSION, PAIRED_NODE);
    // The agent registry still answers (the `start` event pairs the node), but no
    // projection state exists for it: there is nothing to read, and a number is
    // never invented.
    const events = harness();
    events.parents.set(AGENT, SESSION);

    events.start({ runId: 'r1', id: AGENT });
    await drain();
    events.end({ runId: 'r1', id: AGENT, stopReason: 'error' });
    await drain();

    const read = await stored();
    expect(read.state).toBe('ok');
    if (read.state !== 'ok') return;
    expect(read.doc.samples).toBeUndefined();
    expect(lastMeasurement(SESSION, 'a')).toBeUndefined();
    // The settlement still happened: a measurement is a bonus, never a gate.
    expect(read.doc.nodes[0]).toMatchObject({ status: 'done', verdict: 'fail' });
    // `start` claims only a node *without* an agent, so the two writes here are
    // the settlement and nothing else: no sample write was queued at all.
    expect(read.doc.revision).toBe(2);
  });

  it('skips the sample without a projection registry, and never throws', async () => {
    await seedNode(SESSION, PAIRED_NODE);
    const events = harness();
    measurable(events);
    events.parents.set(AGENT, SESSION);
    events.withoutProjections();

    expect(() => {
      events.end({ runId: 'r1', id: AGENT, stopReason: 'error' });
    }).not.toThrow();
    await drain();

    const read = await stored();
    expect(read.state).toBe('ok');
    if (read.state !== 'ok') return;
    expect(read.doc.samples).toBeUndefined();
    expect(read.doc.nodes[0]).toMatchObject({ status: 'done', verdict: 'fail' });
  });

  it('writes nothing for a child that has no node of its own', async () => {
    await seedNode(SESSION, { ...PAIRED_NODE, agent: 'someone-else' });
    const events = harness();
    measurable(events);
    events.parents.set(AGENT, SESSION);

    events.end({ runId: 'unknown-run', id: AGENT, stopReason: 'error' });
    await drain();

    const read = await stored();
    expect(read.state).toBe('ok');
    if (read.state !== 'ok') return;
    // Another agent's node is not this child's to measure or settle.
    expect(read.doc.samples).toBeUndefined();
    expect(read.doc.revision).toBe(1);
    expect(read.doc.nodes[0]).toMatchObject({ agent: 'someone-else', status: 'running' });
  });

  it('never creates a document for a child it knows nothing about', async () => {
    const events = harness();
    measurable(events);
    events.parents.set(AGENT, 'lonely');

    events.end({ runId: 'r1', id: AGENT, stopReason: 'error' });
    await drain();

    expect((await stored('lonely')).state).toBe('missing');
  });
});
