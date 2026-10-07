import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { clearMeasurements, lastMeasurement } from '../../../src/dag/dag-metrics.js';
import { readDag, updateDag } from '../../../src/dag/dag-store.js';
import { installDagLifecycle, withSample } from '../../../src/dag/dag-lifecycle.js';
import type { DagDoc } from '../../../src/dag/dag.js';
import type { DagRead } from '../../../src/dag/dag-store.js';
import type { DagNodeView } from '../../../src/shared/records.js';
import type { DshContext } from '../../../src/shared/types.js';

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

/**
 * 兜底结算写进 `note` 的前缀，与 `src/dag/dag-lifecycle.ts` 的 `FALLBACK_MARK` 同值。
 *
 * 这里**故意另写一份**（不 import 那个未导出的常量）：断言的是节点 note 上真的多了
 * 那串可读文字，同值重复一次正是「契约」与「实现」分离的意义。
 */
const FALLBACK_MARK = '[fallback 认领] ';

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

describe('subagent/end 的兜底认领', () => {
  it('agent 找不到节点时，按认领记录结算并打上 fallback 前缀，样本也落回该节点', async () => {
    // 不带 agent 的 running 节点 = `start` 会认领的那个；`someone-else` 是之后被
    // 覆盖上去的（模拟错位/被覆盖），于是按 agent 定位必然找不到。
    await seedNode(SESSION, { id: 'a', label: '总①', title: 't', phase: 'exec', status: 'running' });
    const events = harness();
    measurable(events);
    events.parents.set(AGENT, SESSION);

    events.start({ runId: 'r1', id: AGENT });
    await drain();
    const claimed = await stored();
    expect(claimed.state).toBe('ok');
    if (claimed.state !== 'ok') return;
    expect(claimed.doc.nodes[0]?.agent).toBe(AGENT);

    await updateDag(SESSION, (state) => {
      if (state.state !== 'ok') return { skip: true };
      return {
        doc: { ...state.doc, nodes: state.doc.nodes.map((node) => ({ ...node, agent: 'someone-else' })) },
      };
    }, dir);

    events.end({ runId: 'r1', id: AGENT, stopReason: 'error' });
    await drain();

    const read = await stored();
    expect(read.state).toBe('ok');
    if (read.state !== 'ok') return;
    expect(read.doc.nodes[0]).toMatchObject({ status: 'done', verdict: 'fail' });
    expect(read.doc.nodes[0]?.note?.startsWith(FALLBACK_MARK)).toBe(true);
    // 认领过的节点 id 也是样本的落点：agent 对不上，兜底记录还认得出它。
    expect(read.doc.samples?.['a']?.tokens).toBe(124);
  });

  it('有配对记录但没认领到节点时，不写样本也不结算该 agent 的节点', async () => {
    // 这次 `end` 的 runId 从未 `start` 过：remembered 为 undefined，而节点带着
    // 另一个 agent，所以按 id 结算的那条分支必须**不被调用**。
    await seedNode(SESSION, { ...PAIRED_NODE, agent: 'someone-else' });
    const events = harness();
    measurable(events);
    events.parents.set(AGENT, SESSION);

    events.end({ runId: 'never-started', id: AGENT, stopReason: 'error' });
    await drain();

    const read = await stored();
    expect(read.state).toBe('ok');
    if (read.state !== 'ok') return;
    expect(read.doc.revision).toBe(1);
    expect(read.doc.nodes[0]).toMatchObject({ agent: 'someone-else', status: 'running' });
    expect(read.doc.samples).toBeUndefined();
  });

  it('按 agent 结算成功时，note 不带 fallback 前缀', async () => {
    // 与第一条互补：这里 `start` 的认领把 `agent` 回填成 AGENT，之后没人覆盖它，
    // 于是 `end` 走的是「按 agent 结算」那条路——fallback 分支不该被碰到。
    await seedNode(SESSION, { id: 'a', label: '总①', title: 't', phase: 'exec', status: 'running' });
    const events = harness();
    events.parents.set(AGENT, SESSION);

    events.start({ runId: 'r1', id: AGENT });
    await drain();
    events.end({ runId: 'r1', id: AGENT, stopReason: 'boom' });
    await drain();

    const read = await stored();
    expect(read.state).toBe('ok');
    if (read.state !== 'ok') return;
    expect(read.doc.nodes[0]?.note).toBe('boom');
    expect(read.doc.nodes[0]?.note?.includes(FALLBACK_MARK)).toBe(false);
    expect(read.doc.nodes[0]).toMatchObject({ status: 'done', verdict: 'fail' });
  });
});

describe('withSample', () => {
  /** 一份最小文档：一个节点 `a`，可选带上模型自报的 `tokens`。 */
  function doc(tokens?: number): DagDoc {
    return {
      version: 1,
      session: SESSION,
      title: 'DAG',
      revision: 1,
      created_at: 'T',
      updated_at: 'T',
      nodes: [
        {
          id: 'a',
          label: '总①',
          title: 't',
          phase: 'exec',
          status: 'running',
          depends_on: [],
          updated_at: 'T',
          ...(tokens === undefined ? {} : { tokens }),
        },
      ],
      edges: [],
    };
  }

  it('给了实测 tokens 就写进节点字段，且 revision 只 +1', () => {
    // 宿主实测优先于模型自报：读数与节点字段落在**同一次**更新里。
    const next = withSample(doc(999), 'a', { tokens: 400, elapsed_ms: 100, at: 5 }, 'T2', 400);
    expect(next?.revision).toBe(2);
    expect(next?.nodes[0]?.tokens).toBe(400);
    expect(next?.samples?.['a']).toEqual({ tokens: 400, elapsed_ms: 100, at: 5 });
    expect(next?.updated_at).toBe('T2');
  });

  it('不给 tokens 时只落 samples，节点自报值原样保留', () => {
    const next = withSample(doc(999), 'a', { tokens: 400, at: 5 }, 'T2');
    expect(next?.nodes[0]?.tokens).toBe(999);
    expect(next?.samples?.['a']).toEqual({ tokens: 400, at: 5 });
  });

  it('同一 at 已存过就 skip，也不写 tokens', () => {
    const stored: DagDoc = { ...doc(999), samples: { a: { tokens: 400, at: 5 } } };
    expect(withSample(stored, 'a', { tokens: 400, at: 5 }, 'T2', 400)).toBeUndefined();
  });
});
