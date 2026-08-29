import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  commitReminderListener,
  installCommitReminder,
  installFailureSignal,
  isGitCommit,
} from './reminders.js';
import type { DshContext, ToolExecutionLike, ToolResultLike } from './types.js';

function makeCtx(): {
  ctx: DshContext;
  listeners: Record<string, (...args: unknown[]) => unknown>;
} {
  const listeners: Record<string, (...args: unknown[]) => unknown> = {};
  const ctx: DshContext = {
    on: (event, listener) => {
      listeners[event] = listener as (...args: unknown[]) => unknown;
      return () => {};
    },
  };
  return { ctx, listeners };
}

const successResult: ToolResultLike = { isError: false, content: [{ type: 'text', text: 'ok' }] };

describe('isGitCommit', () => {
  it('matches git commit commands', () => {
    expect(isGitCommit({ name: 'bash', arguments: { command: 'git commit -m "x"' } })).toBe(true);
    expect(isGitCommit({ name: 'bash', arguments: { command: 'cd repo && git commit --amend' } })).toBe(
      true,
    );
  });

  it('rejects non-commit and non-bash calls', () => {
    expect(isGitCommit({ name: 'bash', arguments: { command: 'git log --oneline' } })).toBe(false);
    expect(isGitCommit({ name: 'read', arguments: { command: 'git commit' } })).toBe(false);
  });
});

describe('commitReminderListener', () => {
  it('appends a reminder after a git commit', async () => {
    const exec: ToolExecutionLike = { name: 'bash', arguments: { command: 'git commit -m "feat: x"' } };
    const next = vi.fn(() => Promise.resolve({ kind: 'accept' as const }));
    const decision = await commitReminderListener(exec, successResult, next);

    expect(decision.kind).toBe('accept');
    expect(decision.content).toHaveLength(2);
    expect(decision.content?.[1]?.type).toBe('text');
    expect(decision.content?.[1]?.text).toContain('state commit');
    expect(decision.content?.[0]).toBe(successResult.content[0]);
    expect(next).not.toHaveBeenCalled();
  });

  it('defers to next() on a non-commit call', async () => {
    const exec: ToolExecutionLike = { name: 'bash', arguments: { command: 'git log' } };
    const next = vi.fn(() => Promise.resolve({ kind: 'accept' as const }));
    const decision = await commitReminderListener(exec, successResult, next);

    expect(next).toHaveBeenCalled();
    expect(decision).toEqual({ kind: 'accept' });
  });
});

describe('installCommitReminder', () => {
  it('registers a tools/post-execute listener', () => {
    const { ctx, listeners } = makeCtx();
    installCommitReminder(ctx);
    expect(listeners['tools/post-execute']).toBeTypeOf('function');
  });
});

describe('installFailureSignal', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes a hint when a tool fails', () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const { ctx, listeners } = makeCtx();
    installFailureSignal(ctx);

    const listener = listeners['tools/result'] as (
      exec: ToolExecutionLike,
      result: ToolResultLike,
    ) => void;
    listener({ name: 'bash', arguments: {} }, { isError: true, error: { message: 'boom' }, content: [] });

    expect(write).toHaveBeenCalledWith(expect.stringContaining('[mint] tool bash failed'));
    expect(write).toHaveBeenCalledWith(expect.stringContaining('mint add'));
  });

  it('stays silent on a successful tool result', () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const { ctx, listeners } = makeCtx();
    installFailureSignal(ctx);

    const listener = listeners['tools/result'] as (
      exec: ToolExecutionLike,
      result: ToolResultLike,
    ) => void;
    listener({ name: 'bash', arguments: {} }, successResult);

    expect(write).not.toHaveBeenCalled();
  });
});
