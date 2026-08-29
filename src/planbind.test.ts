import { describe, expect, it, vi } from 'vitest';

import { installPlanBinding, planBindListener } from './planbind.js';
import type { DshContext, ShellLike, ShellSpecLike, ToolExecutionLike } from './types.js';

function makeShell(
  script: Array<{ exitCode?: number; stdout?: string; stderr?: string }>,
): ShellLike {
  const runs = [...script];
  return {
    resolve: (request) => ({ command: request.command, workdir: '/proj', timeoutMs: request.timeoutMs ?? 30_000 }),
    run: (_spec: ShellSpecLike) => {
      const step = runs.shift() ?? { stdout: '{}' };
      return Promise.resolve({
        exitCode: step.exitCode ?? 0,
        stdout: { text: step.stdout ?? '' },
        stderr: { text: step.stderr ?? '' },
      });
    },
  };
}

function makeExec(name: string, shell?: ShellLike): ToolExecutionLike {
  return {
    name,
    arguments: { command: '' },
    ...(shell ? { agent: { ctx: { shell } } } : {}),
  };
}

const next = () => Promise.resolve({ kind: 'allow' as const });

describe('planBindListener', () => {
  it('denies exit_plan_mode when no active mint plan', async () => {
    const exec = makeExec('exit_plan_mode', makeShell([{ stdout: '{"items":[]}' }]));
    const spy = vi.fn(next);
    const decision = await planBindListener(exec, spy);

    expect(decision.kind).toBe('deny');
    expect(decision.reason).toContain('mint plan create');
    expect(spy).not.toHaveBeenCalled();
  });

  it('allows exit_plan_mode when an active plan exists', async () => {
    const exec = makeExec(
      'exit_plan_mode',
      makeShell([{ stdout: '{"items":[{"id":5,"status":"open","title":"x"}]}' }]),
    );
    const spy = vi.fn(next);
    const decision = await planBindListener(exec, spy);

    expect(spy).toHaveBeenCalled();
    expect(decision).toEqual({ kind: 'allow' });
  });

  it('ignores terminal plans (all done)', async () => {
    const exec = makeExec(
      'exit_plan_mode',
      makeShell([{ stdout: '{"items":[{"id":1,"status":"done","title":"a"}]}' }]),
    );
    const decision = await planBindListener(exec, vi.fn(next));
    expect(decision.kind).toBe('deny');
  });

  it('defers to next() on a non-exit tool', async () => {
    const exec = makeExec('bash');
    const spy = vi.fn(next);
    const decision = await planBindListener(exec, spy);
    expect(spy).toHaveBeenCalled();
    expect(decision).toEqual({ kind: 'allow' });
  });

  it('falls through to next() on mint failure', async () => {
    const exec = makeExec('exit_plan_mode', makeShell([{ exitCode: 1, stderr: 'boom' }]));
    const spy = vi.fn(next);
    const decision = await planBindListener(exec, spy);
    expect(spy).toHaveBeenCalled();
    expect(decision).toEqual({ kind: 'allow' });
  });

  it('falls through to next() without a shell', async () => {
    const exec = makeExec('exit_plan_mode');
    const spy = vi.fn(next);
    const decision = await planBindListener(exec, spy);
    expect(spy).toHaveBeenCalled();
    expect(decision).toEqual({ kind: 'allow' });
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
