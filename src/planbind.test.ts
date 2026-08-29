import { describe, expect, it, vi, beforeEach } from 'vitest';

import { installPlanBinding, planBindListener } from './planbind.js';
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
    expect(decision.reason).toContain('mint plan create');
    expect(spy).not.toHaveBeenCalled();
    expect(runMintMock).toHaveBeenCalledWith('/proj', ['plan', 'list', '--json']);
  });

  it('allows exit_plan_mode when an active plan exists', async () => {
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
    expect(runMintMock).toHaveBeenCalledWith(process.cwd(), ['plan', 'list', '--json']);
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
