import { describe, expect, it } from 'vitest';

import type { DagView, MintDagPayload, MintResponse } from '../../../src/shared/records.js';
import { DAG_PROBE_MS, DAG_TAB_KIND, shouldOpenDag, startDagAutoOpen } from '../../../src/client/dag-open.js';
import type { DagOpenHost, DagOpenOptions } from '../../../src/client/dag-open.js';
import type { SidebarOpenTabLike } from '../../../src/client/types.js';

/** One node, enough for the "has something to draw" test. */
const NODE = {
  id: 'a',
  label: 'a',
  title: 'node a',
  phase: 'exec' as const,
  status: 'pending' as const,
  depends_on: [],
  updated_at: '2026-01-01T00:00:00Z',
};

/** A document with one node, or an empty one when `nodes` is false. */
function doc(nodes = true): DagView {
  return {
    title: 'plan',
    revision: 1,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    nodes: nodes ? [NODE] : [],
    edges: [],
  };
}

/** A payload as the route answers it, overridable field by field. */
function payload(extra: Partial<MintDagPayload> = {}): MintDagPayload {
  return { ok: true, dag: doc(), revision: 1, file: '/tmp/mint/dag/s1.json', autoOpen: true, ...extra };
}

/** A manual clock: the callback is recorded and fired by the test. */
function fakeTimers(): {
  timers: NonNullable<DagOpenOptions['timers']>;
  tick: () => Promise<void>;
  armed: () => number;
} {
  const handles = new Map<number, () => void>();
  let next = 1;
  let current = 0;
  return {
    timers: {
      setInterval: (cb) => {
        current = next++;
        handles.set(current, cb);
        return current;
      },
      clearInterval: (handle) => {
        handles.delete(handle as number);
      },
    },
    tick: async () => {
      for (const cb of [...handles.values()]) cb();
      // Two awaits: the tick awaits the probe, whose `.then` resolves after it.
      await Promise.resolve();
      await Promise.resolve();
    },
    armed: () => handles.size,
  };
}

/** A sidebar double: one mounted session, a settable open-tab list. */
function sidebarDouble(tabs: SidebarOpenTabLike[] = []): {
  sidebarRight: DagOpenHost['sidebarRight'];
  opened: string[];
  tabs: SidebarOpenTabLike[];
} {
  const opened: string[] = [];
  const state = { tabs };
  return {
    opened,
    get tabs() {
      return state.tabs;
    },
    set tabs(value) {
      state.tabs = value;
    },
    sidebarRight: {
      openTab: (kind) => {
        opened.push(kind);
      },
      mounted: { getSnapshot: () => 's1' },
      openTabs: { getSnapshot: () => state.tabs },
    },
  };
}

describe('shouldOpenDag', () => {
  it('opens for a session whose document has nodes and no tab yet', () => {
    expect(shouldOpenDag(payload(), [], 's1')).toBe(true);
  });

  it('does not open without a document', () => {
    expect(shouldOpenDag(payload({ dag: null }), [], 's1')).toBe(false);
  });

  // An `init` with no nodes is not a reason to take the user's focus.
  it('does not open for an empty document', () => {
    expect(shouldOpenDag(payload({ dag: doc(false) }), [], 's1')).toBe(false);
  });

  it('does not open when this session already has the tab', () => {
    const tabs: SidebarOpenTabLike[] = [{ sessionId: 's1', kind: DAG_TAB_KIND }];
    expect(shouldOpenDag(payload(), tabs, 's1')).toBe(false);
  });

  // Another session's tab is not this one's: the kind is per-session.
  it('opens for a session whose tab is not open yet', () => {
    const tabs: SidebarOpenTabLike[] = [
      { sessionId: 'other', kind: DAG_TAB_KIND },
      { sessionId: 's1', kind: 'mint' },
    ];
    expect(shouldOpenDag(payload(), tabs, 's1')).toBe(true);
  });
});

describe('startDagAutoOpen', () => {
  /** A host whose probe answers through `answer`, recording every session read. */
  function host(
    answer: (sessionId: string) => Promise<MintResponse<MintDagPayload>>,
    tabs: SidebarOpenTabLike[] = []
  ): { host: DagOpenHost; opened: string[]; asked: string[]; tabs: SidebarOpenTabLike[] } {
    const seat = sidebarDouble(tabs);
    const asked: string[] = [];
    return {
      opened: seat.opened,
      asked,
      get tabs() {
        return seat.tabs;
      },
      set tabs(value) {
        seat.tabs = value;
      },
      host: {
        sidebarRight: seat.sidebarRight,
        apiFor: (sessionId) => {
          asked.push(sessionId);
          return { dag: async () => answer(sessionId) };
        },
      },
    };
  }

  it('probes at the spec interval by default', () => {
    // The default is what the page runs with; the injected timers only replace
    // the clock, so the constant itself is the assertion.
    expect(DAG_PROBE_MS).toBe(5000);
  });

  it('opens the tab once the probe finds a document', async () => {
    const clock = fakeTimers();
    const world = host(() => Promise.resolve(payload()));
    const stop = startDagAutoOpen(world.host, { timers: clock.timers });
    expect(world.asked).toEqual([]);
    await clock.tick();
    expect(world.asked).toEqual(['s1']);
    expect(world.opened).toEqual([DAG_TAB_KIND]);
    stop();
  });

  it('does not re-open while the tab is already there', async () => {
    const clock = fakeTimers();
    const world = host(() => Promise.resolve(payload()), [{ sessionId: 's1', kind: DAG_TAB_KIND }]);
    const stop = startDagAutoOpen(world.host, { timers: clock.timers });
    await clock.tick();
    await clock.tick();
    expect(world.opened).toEqual([]);
    stop();
  });

  it('asks again on the next tick, so a document that appears later is caught', async () => {
    const clock = fakeTimers();
    let answer = payload({ dag: null });
    const world = host(() => Promise.resolve(answer));
    const stop = startDagAutoOpen(world.host, { timers: clock.timers });
    await clock.tick();
    expect(world.opened).toEqual([]);
    answer = payload();
    await clock.tick();
    expect(world.opened).toEqual([DAG_TAB_KIND]);
    stop();
  });

  it('stops probing for good when the host turns auto-open off', async () => {
    const clock = fakeTimers();
    const world = host(() => Promise.resolve(payload({ autoOpen: false })));
    const stop = startDagAutoOpen(world.host, { timers: clock.timers });
    await clock.tick();
    expect(world.opened).toEqual([]);
    expect(clock.armed()).toBe(0);
    await clock.tick();
    expect(world.asked).toEqual(['s1']);
    stop();
  });

  it('skips the request entirely while the page is hidden', async () => {
    const clock = fakeTimers();
    const world = host(() => Promise.resolve(payload()));
    const stop = startDagAutoOpen(world.host, { timers: clock.timers, visible: () => false });
    await clock.tick();
    expect(world.asked).toEqual([]);
    stop();
  });

  it('skips a tick with no mounted session', async () => {
    const clock = fakeTimers();
    const world = host(() => Promise.resolve(payload()));
    const bare: DagOpenHost = {
      sidebarRight: { ...world.host.sidebarRight, mounted: { getSnapshot: () => undefined } },
      apiFor: (sessionId) => world.host.apiFor(sessionId),
    };
    const stop = startDagAutoOpen(bare, { timers: clock.timers });
    await clock.tick();
    expect(world.asked).toEqual([]);
    stop();
  });

  // A probe is background work: neither a transport failure nor a refusal
  // envelope may escape into the session that is merely hosting the tab.
  it('swallows a transport failure and keeps probing', async () => {
    const clock = fakeTimers();
    let calls = 0;
    const world = host(() => {
      calls += 1;
      return calls === 1
        ? Promise.reject(new Error('network down'))
        : Promise.resolve(payload());
    });
    const stop = startDagAutoOpen(world.host, { timers: clock.timers });
    await clock.tick();
    expect(world.opened).toEqual([]);
    await clock.tick();
    expect(world.opened).toEqual([DAG_TAB_KIND]);
    stop();
  });

  it('ignores a failure envelope', async () => {
    const clock = fakeTimers();
    const world = host(() => Promise.resolve({ ok: false as const, error: 'session-not-live' }));
    const stop = startDagAutoOpen(world.host, { timers: clock.timers });
    await clock.tick();
    expect(world.opened).toEqual([]);
    expect(clock.armed()).toBe(1);
    stop();
  });

  it('stops the timer and the probing when disposed', async () => {
    const clock = fakeTimers();
    const world = host(() => Promise.resolve(payload()));
    const stop = startDagAutoOpen(world.host, { timers: clock.timers });
    stop();
    expect(clock.armed()).toBe(0);
    await clock.tick();
    expect(world.asked).toEqual([]);
  });

  it('disposes idempotently', async () => {
    const clock = fakeTimers();
    const world = host(() => Promise.resolve(payload()));
    const stop = startDagAutoOpen(world.host, { timers: clock.timers });
    stop();
    stop();
    await clock.tick();
    expect(world.asked).toEqual([]);
  });
});
