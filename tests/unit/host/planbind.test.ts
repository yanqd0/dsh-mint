import { describe, expect, it, vi, beforeEach } from 'vitest';

import {
  installPlanBinding,
  isDecomposedPlan,
  multiRunningCluster,
  planBindListener,
} from '../../../src/host/planbind.js';
import { runMint } from '../../../src/mint/mint.js';
import { notePlanModeState, resetSessionLedger } from '../../../src/host/session-ledger.js';
import type { DshContext, ToolExecutionLike } from '../../../src/shared/types.js';

vi.mock('../../../src/mint/mint.js', () => ({ runMint: vi.fn() }));
const runMintMock = vi.mocked(runMint);

beforeEach(() => {
  runMintMock.mockReset();
  resetSessionLedger();
});

function makeExec(name: string, cwd?: string, sessionId?: string): ToolExecutionLike {
  return {
    name,
    arguments: { command: '' },
    ...(cwd || sessionId
      ? {
          agent: {
            session: { ...(sessionId ? { id: sessionId } : {}), header: { cwd: cwd ?? '/proj' } },
          },
        }
      : {}),
  };
}

const next = () => Promise.resolve({ kind: 'allow' as const });

/**
 * A root-style context (#142). `planMode` is passed through `sessionProjections`
 * because that is the only plan-state source a root-layer plugin can reach: the
 * plan-mode service sits in an isolated cordis group.
 */
function makeCtx(projections: unknown): DshContext {
  return {
    on: () => () => {},
    get: (name: string) => (name === 'sessionProjections' ? projections : undefined),
  };
}

/** A `sessionProjections` stub answering one plan state for every session. */
function projectionsReporting(state: unknown): {
  stateOf: ReturnType<typeof vi.fn>;
} {
  return { stateOf: vi.fn(() => state as { active?: unknown } | undefined) };
}

describe('planBindListener', () => {
  it('denies exit_plan_mode when no active mint plan', async () => {
    runMintMock.mockResolvedValueOnce({ ok: true, text: '{"items":[]}' });
    const exec = makeExec('exit_plan_mode', '/proj');
    const spy = vi.fn(next);
    const decision = await planBindListener(exec, spy);

    expect(decision.kind).toBe('deny');
    expect(decision.reason).toContain('mint({args:["plan","create"');
    expect(spy).not.toHaveBeenCalled();
    expect(runMintMock).toHaveBeenCalledWith('/proj', ['plan', 'list', '--json', '--no-page']);
  });

  it('allows exit_plan_mode when a running plan exists (#59)', async () => {
    runMintMock.mockResolvedValueOnce({
      ok: true,
      text: '{"items":[{"id":5,"status":"running","issue_count":2,"title":"x"}]}',
    });
    const exec = makeExec('exit_plan_mode', '/proj');
    const spy = vi.fn(next);
    const decision = await planBindListener(exec, spy);

    expect(spy).toHaveBeenCalled();
    expect(decision).toEqual({ kind: 'allow' });
  });

  it('reads the whole plan table, so an older running plan still counts (#93)', async () => {
    // Pre-#93 the gate took mint's default page of five (newest id first), so a
    // running plan older than the five newest read as "no plan at all". The argv
    // is the fix; this six-plan answer is what that argv exists for. The five
    // open rows carry `issue_count: 0`, so the running one is the only record
    // that can satisfy the gate here (#135).
    runMintMock.mockResolvedValueOnce({
      ok: true,
      text: JSON.stringify({
        items: [
          ...Array.from({ length: 5 }, (_, index) => ({
            id: 12 - index,
            status: 'open',
            issue_count: 0,
          })),
          { id: 1, status: 'running', issue_count: 2, title: 'old' },
        ],
      }),
    });
    const exec = makeExec('exit_plan_mode', '/proj');
    const spy = vi.fn(next);
    const decision = await planBindListener(exec, spy);

    expect(spy).toHaveBeenCalled();
    expect(decision).toEqual({ kind: 'allow' });
    expect(runMintMock).toHaveBeenCalledWith('/proj', ['plan', 'list', '--json', '--no-page']);
  });

  it('denies two running plans in the same milestone (#140)', async () => {
    runMintMock.mockResolvedValueOnce({
      ok: true,
      text: JSON.stringify({
        items: [
          { id: 27, status: 'running', issue_count: 3, milestone_id: 4, title: 'a' },
          { id: 31, status: 'running', issue_count: 1, milestone_id: 4, title: 'b' },
        ],
      }),
    });
    const exec = makeExec('exit_plan_mode', '/proj');
    const spy = vi.fn(next);
    const decision = await planBindListener(exec, spy);

    expect(decision.kind).toBe('deny');
    expect(decision.reason).toContain('#27');
    expect(decision.reason).toContain('#31');
    // The only enforcement point is this gate, so the message must carry the
    // convergent moves (park the other plan's planned issues / detach the issue
    // that revived a finished plan).
    expect(decision.reason).toContain('"issue","state","reset"');
    expect(decision.reason).toContain('"plan","detach"');
    expect(spy).not.toHaveBeenCalled();
  });

  it('allows two running plans in different milestones (sanctioned parallel versions, #140)', async () => {
    // Only `milestone set --status running --force` puts two versions in flight;
    // that is the user's call, so the plan gate must not fight it.
    runMintMock.mockResolvedValueOnce({
      ok: true,
      text: JSON.stringify({
        items: [
          { id: 27, status: 'running', issue_count: 3, milestone_id: 4 },
          { id: 31, status: 'running', issue_count: 1, milestone_id: 7 },
        ],
      }),
    });
    const exec = makeExec('exit_plan_mode', '/proj');
    const spy = vi.fn(next);
    const decision = await planBindListener(exec, spy);

    expect(spy).toHaveBeenCalled();
    expect(decision).toEqual({ kind: 'allow' });
  });

  it('denies two milestone-less running plans (they share the "none" bucket, #140)', async () => {
    runMintMock.mockResolvedValueOnce({
      ok: true,
      text: JSON.stringify({
        items: [
          { id: 3, status: 'running', issue_count: 1 },
          { id: 9, status: 'running', issue_count: 2 },
        ],
      }),
    });
    const exec = makeExec('exit_plan_mode', '/proj');
    const decision = await planBindListener(exec, vi.fn(next));
    expect(decision.kind).toBe('deny');
  });

  it('still denies a visible collision while another row is unreadable (#140)', async () => {
    // Fail-open must not swallow a collision the gate has already proven.
    runMintMock.mockResolvedValueOnce({
      ok: true,
      text: JSON.stringify({
        items: [
          { id: 27, status: 'running', issue_count: 3, milestone_id: 4 },
          { id: 31, status: 'running', issue_count: 1, milestone_id: 4 },
          { id: 32, title: 'shape drift' },
        ],
      }),
    });
    const exec = makeExec('exit_plan_mode', '/proj');
    const decision = await planBindListener(exec, vi.fn(next));
    expect(decision.kind).toBe('deny');
  });

  it('fails open when a row is unreadable and no collision is visible (#140)', async () => {
    // One unreadable row means the *count* is untrustworthy: stay out of the way.
    runMintMock.mockResolvedValueOnce({
      ok: true,
      text: JSON.stringify({
        items: [
          { id: 27, status: 'running', issue_count: 3, milestone_id: 4 },
          { id: 32, title: 'shape drift' },
        ],
      }),
    });
    const exec = makeExec('exit_plan_mode', '/proj');
    const spy = vi.fn(next);
    const decision = await planBindListener(exec, spy);
    expect(spy).toHaveBeenCalled();
    expect(decision).toEqual({ kind: 'allow' });
  });

  it('allows an open plan that already has an issue attached (#135)', async () => {
    // The #128 shape: every child is still `open`, so mint derives the plan as
    // `open` — the deadlock this case exists for.
    runMintMock.mockResolvedValueOnce({
      ok: true,
      text: '{"items":[{"id":5,"status":"open","issue_count":1,"title":"x"}]}',
    });
    const exec = makeExec('exit_plan_mode', '/proj');
    const spy = vi.fn(next);
    const decision = await planBindListener(exec, spy);

    expect(spy).toHaveBeenCalled();
    expect(decision).toEqual({ kind: 'allow' });
  });

  it('allows an open plan whose issue count is unreadable (fail-open, #135)', async () => {
    runMintMock.mockResolvedValueOnce({
      ok: true,
      text: '{"items":[{"id":5,"status":"open","title":"x"}]}',
    });
    const exec = makeExec('exit_plan_mode', '/proj');
    const spy = vi.fn(next);
    const decision = await planBindListener(exec, spy);

    expect(spy).toHaveBeenCalled();
    expect(decision).toEqual({ kind: 'allow' });
  });

  it('denies an open, issue-less plan instead of passing the gate (#59, #132)', async () => {
    runMintMock.mockResolvedValueOnce({
      ok: true,
      text: '{"items":[{"id":5,"status":"open","issue_count":0,"title":"x"}]}',
    });
    const exec = makeExec('exit_plan_mode', '/proj');
    const spy = vi.fn(next);
    const decision = await planBindListener(exec, spy);

    expect(decision.kind).toBe('deny');
    expect(decision.reason).toContain('mint({args:["plan","attach"');
    // #132: `plan plan` is the start-of-work step (#128), never a gate condition.
    expect(decision.reason).toContain('when the work starts');
    expect(decision.reason).not.toContain('before exiting plan mode');
    expect(spy).not.toHaveBeenCalled();
  });

  it('denies a partial plan (done + dropped is a completion state)', async () => {
    runMintMock.mockResolvedValueOnce({
      ok: true,
      text: '{"items":[{"id":5,"status":"partial","title":"x"}]}',
    });
    const exec = makeExec('exit_plan_mode', '/proj');
    const decision = await planBindListener(exec, vi.fn(next));
    expect(decision.kind).toBe('deny');
  });

  it('fails open when the plan list carries no derived status', async () => {
    runMintMock.mockResolvedValueOnce({
      ok: true,
      text: '{"items":[{"id":5,"title":"x"}]}',
    });
    const exec = makeExec('exit_plan_mode', '/proj');
    const spy = vi.fn(next);
    const decision = await planBindListener(exec, spy);
    expect(spy).toHaveBeenCalled();
    expect(decision).toEqual({ kind: 'allow' });
  });

  it('ignores terminal plans (all done)', async () => {
    runMintMock.mockResolvedValueOnce({
      ok: true,
      text: '{"items":[{"id":1,"status":"done","title":"a"}]}',
    });
    const exec = makeExec('exit_plan_mode', '/proj');
    const decision = await planBindListener(exec, vi.fn(next));
    expect(decision.kind).toBe('deny');
  });

  it('defers to next() on a non-exit tool without touching mint', async () => {
    const exec = makeExec('bash', '/proj');
    const spy = vi.fn(next);
    const decision = await planBindListener(exec, spy);
    expect(spy).toHaveBeenCalled();
    expect(decision).toEqual({ kind: 'allow' });
    expect(runMintMock).not.toHaveBeenCalled();
  });

  it('denies a session outside plan mode, and reads no mint for it (#142)', async () => {
    const projections = projectionsReporting({ active: false });
    const exec = makeExec('exit_plan_mode', '/proj', 'sess-1');
    const spy = vi.fn(next);
    const decision = await planBindListener(exec, spy, undefined, makeCtx(projections));

    expect(decision.kind).toBe('deny');
    expect(decision.reason).toContain('not in plan mode');
    // The host would reject this call anyway: the gate must not pay for a spawn.
    expect(runMintMock).not.toHaveBeenCalled();
    expect(spy).not.toHaveBeenCalled();
    // The projection the host's own `exit_plan_mode` reads.
    expect(projections.stateOf).toHaveBeenCalledWith(exec.agent?.session, 'plan');
  });

  it('reads plan state only after the tool name matches (#142)', async () => {
    const projections = projectionsReporting({ active: false });
    const exec = makeExec('bash', '/proj', 'sess-1');
    const decision = await planBindListener(exec, vi.fn(next), undefined, makeCtx(projections));

    expect(decision).toEqual({ kind: 'allow' });
    expect(projections.stateOf).not.toHaveBeenCalled();
    expect(runMintMock).not.toHaveBeenCalled();
  });

  it('keeps the mint gate while plan mode is active (#142)', async () => {
    runMintMock.mockResolvedValueOnce({
      ok: true,
      text: '{"items":[{"id":5,"status":"running","issue_count":1,"milestone_id":4}]}',
    });
    const exec = makeExec('exit_plan_mode', '/proj', 'sess-1');
    const spy = vi.fn(next);
    const ctx = makeCtx(projectionsReporting({ active: true }));
    const decision = await planBindListener(exec, spy, undefined, ctx);

    expect(spy).toHaveBeenCalled();
    expect(decision).toEqual({ kind: 'allow' });
  });

  it('falls back to the observed session event when the projection is unreachable (#142)', async () => {
    // The plan-mode service is isolated from this layer, so a host whose
    // projection key or registry drifts still gets a truthful answer whenever
    // this process saw the session toggle plan mode off.
    notePlanModeState('sess-1', false);
    const exec = makeExec('exit_plan_mode', '/proj', 'sess-1');
    const spy = vi.fn(next);
    for (const projections of [
      undefined,
      {
        stateOf: () => {
          throw new Error('no plan projection');
        },
      },
      projectionsReporting(undefined),
    ]) {
      const decision = await planBindListener(exec, spy, undefined, makeCtx(projections));
      expect(decision.kind).toBe('deny');
      expect(decision.reason).toContain('not in plan mode');
    }
    expect(runMintMock).not.toHaveBeenCalled();
    expect(spy).not.toHaveBeenCalled();
  });

  it('keeps the mint gate when the ledger observed plan mode on, or knows nothing (#142)', async () => {
    for (const sessionId of ['sess-on', 'sess-unknown']) {
      notePlanModeState('sess-on', true);
      runMintMock.mockResolvedValueOnce({ ok: true, text: '{"items":[]}' });
      const exec = makeExec('exit_plan_mode', '/proj', sessionId);
      const decision = await planBindListener(exec, vi.fn(next), undefined, makeCtx(undefined));

      expect(decision.kind).toBe('deny');
      expect(decision.reason).toContain('mint({args:["plan","create"');
      expect(runMintMock).toHaveBeenCalled();
    }
  });

  it('trusts the projection over the ledger (#142)', async () => {
    notePlanModeState('sess-1', false);
    runMintMock.mockResolvedValueOnce({ ok: true, text: '{"items":[]}' });
    // The projection says active ⇒ the gate runs; the stale ledger must not deny.
    const decision = await planBindListener(
      makeExec('exit_plan_mode', '/proj', 'sess-1'),
      vi.fn(next),
      undefined,
      makeCtx(projectionsReporting({ active: true }))
    );

    expect(decision.kind).toBe('deny');
    expect(decision.reason).toContain('mint({args:["plan","create"');
    expect(runMintMock).toHaveBeenCalled();
  });

  it('falls through to next() on mint failure', async () => {
    runMintMock.mockResolvedValueOnce({ ok: false, error: 'boom' });
    const exec = makeExec('exit_plan_mode', '/proj');
    const spy = vi.fn(next);
    const decision = await planBindListener(exec, spy);
    expect(spy).toHaveBeenCalled();
    expect(decision).toEqual({ kind: 'allow' });
  });

  it('falls through to next() when the mint run throws (fail-open, #16)', async () => {
    runMintMock.mockRejectedValueOnce(new Error('spawn exploded'));
    const exec = makeExec('exit_plan_mode', '/proj');
    const spy = vi.fn(next);
    const decision = await planBindListener(exec, spy);
    expect(spy).toHaveBeenCalled();
    expect(decision).toEqual({ kind: 'allow' });
  });

  it('uses process.cwd() when the session has no cwd', async () => {
    runMintMock.mockResolvedValueOnce({ ok: true, text: '{"items":[]}' });
    const exec = makeExec('exit_plan_mode');
    const decision = await planBindListener(exec, vi.fn(next));
    expect(decision.kind).toBe('deny');
    expect(runMintMock).toHaveBeenCalledWith(process.cwd(), [
      'plan',
      'list',
      '--json',
      '--no-page',
    ]);
  });
});

describe('installPlanBinding', () => {
  it('registers a tools/pre-execute listener', () => {
    const listeners: Record<string, unknown> = {};
    const ctx: DshContext = {
      on: (event, listener) => {
        listeners[event] = listener;
        return () => {};
      },
    };
    installPlanBinding(ctx);
    expect(listeners['tools/pre-execute']).toBeTypeOf('function');
  });
});

describe('isDecomposedPlan (#135)', () => {
  it('accepts a running plan whatever the count says', () => {
    expect(isDecomposedPlan({ status: 'running', issue_count: 2 })).toBe(true);
    // `running` is derived from an active child, so an odd count must not flip it.
    expect(isDecomposedPlan({ status: 'running', issue_count: 0 })).toBe(true);
    expect(isDecomposedPlan({ status: 'running' })).toBe(true);
  });

  it('accepts an open plan only once it has an issue attached (#59 stays closed)', () => {
    expect(isDecomposedPlan({ status: 'open', issue_count: 1 })).toBe(true);
    expect(isDecomposedPlan({ status: 'open', issue_count: 0 })).toBe(false);
    expect(isDecomposedPlan({ status: 'open' })).toBe(true);
  });

  it('rejects completion states and unreadable statuses', () => {
    for (const status of ['partial', 'done', 'dropped', '', 'RUNNING']) {
      expect(isDecomposedPlan({ status, issue_count: 3 }), status).toBe(false);
    }
    expect(isDecomposedPlan({ issue_count: 3 })).toBe(false);
    expect(isDecomposedPlan({ status: 7, issue_count: 3 })).toBe(false);
  });
});

describe('multiRunningCluster (#140)', () => {
  it('ignores single running plans and non-running rows', () => {
    expect(multiRunningCluster([])).toEqual([]);
    expect(multiRunningCluster([{ id: 1, status: 'running', milestone_id: 4 }])).toEqual([]);
    expect(
      multiRunningCluster([
        { id: 1, status: 'open', issue_count: 2, milestone_id: 4 },
        { id: 2, status: 'partial', milestone_id: 4 },
      ])
    ).toEqual([]);
  });

  it('clusters running plans by milestone, and only inside one bucket', () => {
    const same = multiRunningCluster([
      { id: 1, status: 'running', milestone_id: 4 },
      { id: 2, status: 'running', milestone_id: 4 },
    ]);
    expect(same.map((item) => item.id)).toEqual([1, 2]);

    expect(
      multiRunningCluster([
        { id: 1, status: 'running', milestone_id: 4 },
        { id: 2, status: 'running', milestone_id: 7 },
      ])
    ).toEqual([]);
  });

  it('buckets a missing or unreadable milestone as the shared "none" bucket', () => {
    // A text/non-numeric milestone is not a version identity, so it collides with
    // the rows that carry no milestone at all — an unreadable key must not disarm
    // the rule.
    expect(
      multiRunningCluster([
        { id: 1, status: 'running' },
        { id: 2, status: 'running', milestone_id: null },
      ]).map((item) => item.id)
    ).toEqual([1, 2]);

    expect(
      multiRunningCluster([
        { id: 3, status: 'running', milestone_id: '4' },
        { id: 4, status: 'running', milestone_id: 5 },
      ])
    ).toEqual([]);
  });
});
