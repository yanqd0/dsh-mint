import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { emptyDag, applyDagWrite } from './dag.js';
import {
  DAG_PLAN_REMINDER,
  MAX_REMINDED_SESSIONS,
  dagPlanReminderListener,
  installDagPlanReminder,
  resetDagPlanNotified,
} from './dag-plan-reminder.js';
import { updateDag } from './dag-store.js';
import { notePlanModeState, resetSessionLedger } from './session-ledger.js';
import type {
  DshContext,
  PostToolDecisionLike,
  ToolExecutionLike,
  ToolResultLike,
} from './types.js';

/**
 * The empty-DAG reminder (#169).
 *
 * The condition is a pair — "this session is in plan mode" **and** "its DAG is
 * missing or empty" — so each half gets a negative case, plus the two ambient
 * facts every session-scoped notice honours (a failed call changed nothing, a
 * subagent's session is not the panel's session) and the once-per-session rule.
 * The DAG is read through the real store from a temp directory (the same seam
 * `routes.test.ts` uses), so path validation and the document shape are real.
 */
let dagDir: string;
let exec: ToolExecutionLike;

/** A session in plan mode, as the ledger observed it (the #142 fallback route). */
function planModeExec(sessionId = 'sess-1'): ToolExecutionLike {
  notePlanModeState(sessionId, true);
  return {
    name: 'bash',
    arguments: { command: 'ls' },
    agent: { session: { id: sessionId, header: { cwd: '/proj' } } },
  };
}

/**
 * A root-style context. Plan mode is reported through `sessionProjections`,
 * which is the only plan-state source a root-layer plugin can reach (#142).
 */
function makeCtx(projections?: unknown): DshContext {
  return {
    on: () => () => {},
    get: (name: string) => (name === 'sessionProjections' ? projections : undefined),
  };
}

function makeResult(
  content: ToolResultLike['content'] = [{ type: 'text', text: 'ok' }]
): ToolResultLike {
  return { isError: false, content };
}

const next = (): Promise<PostToolDecisionLike> => Promise.resolve({ kind: 'accept' });

/**
 * Run the listener against this case's temp DAG directory.
 *
 * `ctx` stays optional so the tests that do not care about the projection read
 * the ledger's observed plan-mode state instead.
 */
function call(
  exec: ToolExecutionLike,
  result: ToolResultLike,
  nextFn: () => Promise<PostToolDecisionLike>,
  ctx?: DshContext
): Promise<PostToolDecisionLike> {
  return dagPlanReminderListener(exec, result, nextFn, ctx, dagDir);
}

/** Seed one session's document, optionally with a single node. */
async function seed(session: string, nodes: 0 | 1 = 0): Promise<void> {
  const initialized = await updateDag(
    session,
    () => ({ doc: emptyDag(session, '本计划', '2026-01-01T00:00:00.000Z') }),
    dagDir
  );
  expect(initialized.ok).toBe(true);
  if (nodes === 0) return;
  const added = await updateDag(
    session,
    (state) => {
      if (state.state !== 'ok') throw new Error('seed: missing document');
      return applyDagWrite(
        {
          action: 'add',
          nodes: [{ id: 'a', label: '总①', title: '第一轮', phase: 'research', depends_on: [] }],
          edges: [],
        },
        state.doc,
        session,
        '2026-01-01T00:00:01.000Z'
      );
    },
    dagDir
  );
  expect(added.ok).toBe(true);
}

beforeEach(() => {
  dagDir = mkdtempSync(join(tmpdir(), 'dsh-mint-dag-plan-'));
  resetDagPlanNotified();
  resetSessionLedger();
  exec = planModeExec();
});

afterEach(() => {
  rmSync(dagDir, { recursive: true, force: true });
});

describe('dagPlanReminderListener (#169)', () => {
  it('reminds once in plan mode with no DAG at all', async () => {
    const decision = await call(exec, makeResult(), next);

    expect(decision.kind).toBe('accept');
    expect(decision.content?.map((block) => block.text)).toContain(DAG_PLAN_REMINDER);
    // Enrich, not replace: the tool's own content survives.
    expect(decision.content?.[0]).toEqual({ type: 'text', text: 'ok' });
  });

  it('stays quiet on the second call of the same session', async () => {
    const first = await call(exec, makeResult(), next);
    expect(first.content?.map((block) => block.text)).toContain(DAG_PLAN_REMINDER);

    const spy = vi.fn(next);
    const second = await call(exec, makeResult(), spy);

    expect(spy).toHaveBeenCalled();
    expect(second).toEqual({ kind: 'accept' });
  });

  it('treats an initialized but node-less DAG as empty', async () => {
    // The gap this reminder exists for: `init` alone never opens the panel
    // (`src/client/dag-open.ts` requires `nodes.length > 0`), so it leaves no trace.
    await seed('sess-1', 0);

    const decision = await call(exec, makeResult(), next);

    expect(decision.content?.map((block) => block.text)).toContain(DAG_PLAN_REMINDER);
  });

  it('stays quiet once the DAG has a node', async () => {
    await seed('sess-1', 1);
    const spy = vi.fn(next);

    const decision = await call(exec, makeResult(), spy);

    expect(spy).toHaveBeenCalled();
    expect(decision).toEqual({ kind: 'accept' });
  });

  it('stays quiet outside plan mode', async () => {
    // Forget the ambient plan/mode event the shared fixture records: with no
    // ledger entry and no projection, nothing says this session is planning, so
    // there is no discipline to nudge (fail-open, like the gate).
    resetSessionLedger();
    const idle: ToolExecutionLike = {
      name: 'bash',
      arguments: { command: 'ls' },
      agent: { session: { id: 'sess-1', header: { cwd: '/proj' } } },
    };
    const spy = vi.fn(next);

    const decision = await call(idle, makeResult(), spy);

    expect(spy).toHaveBeenCalled();
    // Nothing to say: the waterfall gets `next()`'s own answer, untouched.
    expect(decision).toEqual({ kind: 'accept' });
  });

  it('stays quiet for a subagent session (#113)', async () => {
    const child: ToolExecutionLike = {
      name: 'bash',
      arguments: { command: 'ls' },
      agent: { session: { id: 'sess-1', header: { cwd: '/proj', delegationDepth: 1 } } },
    };
    const spy = vi.fn(next);

    const decision = await call(child, makeResult(), spy);

    expect(spy).toHaveBeenCalled();
    expect(decision).toEqual({ kind: 'accept' });
  });

  it('stays quiet when the tool call failed', async () => {
    // A non-zero exit is a *completed* call whose text carries the marker (#110).
    const failed: ToolResultLike = {
      isError: false,
      content: [{ type: 'text', text: 'boom\n[exit code: 1]' }],
    };
    const spy = vi.fn(next);

    const decision = await call(exec, failed, spy);

    expect(spy).toHaveBeenCalled();
    expect(decision).toEqual({ kind: 'accept' });
  });

  it('swallows an unbuildable DAG path and does not throw', async () => {
    // An invalid session id makes `readDag` throw `DagPathError` before any file
    // access; a reminder must never turn that into a tool-call error.
    exec = planModeExec('sess/bad');
    const spy = vi.fn(next);

    const decision = await call(exec, makeResult(), spy);

    expect(spy).toHaveBeenCalled();
    expect(decision).toEqual({ kind: 'accept' });
  });

  it('trusts the projection over the ledger, and vice versa', async () => {
    // The projection is authoritative: `active:false` outranks the ledger's `true`,
    // so the reminder must not fire for a session the host says is not planning.
    const off = makeCtx({ stateOf: () => ({ active: false }) });
    const spy = vi.fn(next);
    expect(await call(exec, makeResult(), spy, off)).toEqual({
      kind: 'accept',
    });

    // An active projection fires even when the ledger knows nothing: a session
    // restored from disk has no `plan/mode` event in this process.
    resetSessionLedger();
    exec = {
      name: 'bash',
      arguments: { command: 'ls' },
      agent: { session: { id: 'sess-2', header: { cwd: '/proj' } } },
    };
    const on = makeCtx({ stateOf: () => ({ active: true }) });
    const decision = await call(exec, makeResult(), next, on);
    expect(decision.content?.map((block) => block.text)).toContain(DAG_PLAN_REMINDER);
  });
  it('keeps the reminded set bounded, evicting the oldest id (like the ledger)', async () => {
    for (let index = 0; index < MAX_REMINDED_SESSIONS; index += 1) {
      const each: ToolExecutionLike = {
        name: 'bash',
        arguments: { command: 'ls' },
        agent: { session: { id: `s-${index}`, header: { cwd: '/proj' } } },
      };
      const decision = await call(
        each,
        makeResult(),
        next,
        makeCtx({ stateOf: () => ({ active: true }) })
      );
      expect(decision.content?.map((block) => block.text)).toContain(DAG_PLAN_REMINDER);
    }
    // One more session pushes `s-0` out; nothing else about the rule changes.
    const overflow: ToolExecutionLike = {
      name: 'bash',
      arguments: { command: 'ls' },
      agent: { session: { id: 's-overflow', header: { cwd: '/proj' } } },
    };
    await call(overflow, makeResult(), next, makeCtx({ stateOf: () => ({ active: true }) }));
    const evicted: ToolExecutionLike = {
      name: 'bash',
      arguments: { command: 'ls' },
      agent: { session: { id: 's-0', header: { cwd: '/proj' } } },
    };
    const again = await call(
      evicted,
      makeResult(),
      next,
      makeCtx({ stateOf: () => ({ active: true }) })
    );
    expect(again.content?.map((block) => block.text)).toContain(DAG_PLAN_REMINDER);
  });
});

describe('installDagPlanReminder (#169)', () => {
  it('registers a tools/post-execute listener that reads the DAG directory', async () => {
    const listeners: Record<string, unknown> = {};
    const ctx: DshContext = {
      on: (event, listener) => {
        listeners[event] = listener;
        return () => {};
      },
    };
    installDagPlanReminder(ctx, dagDir);

    const listener = listeners['tools/post-execute'] as (
      exec: ToolExecutionLike,
      result: ToolResultLike,
      next: () => Promise<PostToolDecisionLike>
    ) => Promise<PostToolDecisionLike>;
    expect(listener).toBeTypeOf('function');

    // The override has to reach the read, or the listener would consult `/tmp`.
    const decision = await listener(exec, makeResult(), next);
    expect(decision.content?.map((block) => block.text)).toContain(DAG_PLAN_REMINDER);
  });
});
