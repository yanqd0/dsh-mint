import { describe, expect, it, vi, beforeEach } from 'vitest';

import { installPlanBinding, isDecomposedPlan, planBindListener } from './planbind.js';
import { runMint } from './mint.js';
import type { DshContext, ToolExecutionLike } from './types.js';

vi.mock('./mint.js', () => ({ runMint: vi.fn() }));
const runMintMock = vi.mocked(runMint);

beforeEach(() => {
  runMintMock.mockReset();
});

function makeExec(name: string, cwd?: string): ToolExecutionLike {
  return {
    name,
    arguments: { command: '' },
    ...(cwd ? { agent: { session: { header: { cwd } } } } : {}),
  };
}

const next = () => Promise.resolve({ kind: 'allow' as const });

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

  it('denies an open, issue-less plan instead of passing the gate (#59)', async () => {
    runMintMock.mockResolvedValueOnce({
      ok: true,
      text: '{"items":[{"id":5,"status":"open","issue_count":0,"title":"x"}]}',
    });
    const exec = makeExec('exit_plan_mode', '/proj');
    const spy = vi.fn(next);
    const decision = await planBindListener(exec, spy);

    expect(decision.kind).toBe('deny');
    expect(decision.reason).toContain('mint({args:["plan","plan"');
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
