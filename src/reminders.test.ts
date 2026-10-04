import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  SESSION_RECORD_REMINDER,
  commitReminderListener,
  installCommitReminder,
  installFailureSignal,
  installSessionRecordReminder,
  isCommitArgv,
  isFailedResult,
  isGitCommit,
  sessionRecordReminderListener,
} from './reminders.js';
import { recordMintWrite, resetSessionLedger } from './session-ledger.js';
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
    expect(isGitCommit({ name: 'bash', arguments: { command: 'git -c user.name=x commit -m y' } })).toBe(
      true,
    );
  });

  it('matches a git commit run through an argv tool (#110)', () => {
    // The uv tool strips a leading `uv`, so `uv run git commit -m x` arrives so.
    expect(isGitCommit({ name: 'uv', arguments: { args: ['run', 'git', 'commit', '-m', 'x'] } })).toBe(
      true,
    );
    expect(isGitCommit({ name: 'uv', arguments: { args: ['run', '--no-project', 'git', 'commit'] } })).toBe(
      true,
    );
    expect(
      isGitCommit({ name: 'uv', arguments: { args: ['run', 'git', '-C', '/repo', 'commit'] } }),
    ).toBe(true);
  });

  it('rejects non-commit and non-bash calls', () => {
    expect(isGitCommit({ name: 'bash', arguments: { command: 'git log --oneline' } })).toBe(false);
    expect(isGitCommit({ name: 'read', arguments: { command: 'git commit' } })).toBe(false);
    expect(isGitCommit({ name: 'uv', arguments: { args: ['run', 'git', 'log'] } })).toBe(false);
    expect(isGitCommit({ name: 'uv', arguments: { args: ['run', 'pytest', '-q'] } })).toBe(false);
    expect(isGitCommit({ name: 'uv', arguments: { args: [] } })).toBe(false);
    expect(isGitCommit({ name: 'uv', arguments: { args: 'run git commit' } })).toBe(false);
    expect(isGitCommit({ name: 'uv', arguments: {} })).toBe(false);
  });

  it('does not match prose that merely mentions a commit', () => {
    // argv matching is on exact tokens, so a title carrying the words cannot hit.
    expect(
      isGitCommit({ name: 'mint', arguments: { args: ['issue', 'add', 'uv run git commit 不提醒'] } }),
    ).toBe(false);
    expect(isCommitArgv(['git', 'commit'])).toBe(true);
    expect(isCommitArgv(['git', 'commits'])).toBe(false);
    expect(isCommitArgv(['git', '-c'])).toBe(false);
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
    expect(decision.content?.[1]?.text).toContain('mint({args:["issue","state","commit"');
    expect(decision.content?.[0]).toBe(successResult.content[0]);
    expect(next).not.toHaveBeenCalled();
  });

  it('appends the reminder for an argv commit (#110)', async () => {
    const exec: ToolExecutionLike = { name: 'uv', arguments: { args: ['run', 'git', 'commit', '-m', 'x'] } };
    const next = vi.fn(() => Promise.resolve({ kind: 'accept' as const }));
    const decision = await commitReminderListener(exec, successResult, next);

    expect(decision.content?.[1]?.text).toContain('记得用 mint 工具登记');
  });

  it('stays silent when the commit failed (#110)', async () => {
    const exec: ToolExecutionLike = { name: 'bash', arguments: { command: 'git commit -m "x"' } };
    const failed: ToolResultLike = {
      isError: true,
      error: { message: 'pre-commit hook rejected' },
      content: [{ type: 'text', text: 'hook failed' }],
    };
    const next = vi.fn(() => Promise.resolve({ kind: 'accept' as const }));
    const decision = await commitReminderListener(exec, failed, next);

    expect(next).toHaveBeenCalled();
    expect(decision.content).toBeUndefined();
  });

  it('stays silent when the failure only shows as an exit-code marker (#110)', async () => {
    // Live probe result: the uv tool reports `ok:false` as an ordinary tool
    // value, so the host's `isError` stays false and the marker is the only
    // evidence — a rejected commit must not look like a successful one.
    const exec: ToolExecutionLike = {
      name: 'uv',
      arguments: { args: ['run', 'git', 'commit', '-m', 'x'] },
    };
    const failed: ToolResultLike = {
      isError: false,
      content: [
        {
          type: 'text',
          text: 'On branch master\nnothing to commit, working tree clean\n[exit code: 1]',
        },
      ],
    };
    const next = vi.fn(() => Promise.resolve({ kind: 'accept' as const }));
    const decision = await commitReminderListener(exec, failed, next);

    expect(next).toHaveBeenCalled();
    expect(decision.content).toBeUndefined();
  });

  it('defers to next() on a non-commit call', async () => {
    const exec: ToolExecutionLike = { name: 'bash', arguments: { command: 'git log' } };
    const next = vi.fn(() => Promise.resolve({ kind: 'accept' as const }));
    const decision = await commitReminderListener(exec, successResult, next);

    expect(next).toHaveBeenCalled();
    expect(decision).toEqual({ kind: 'accept' });
  });
});

describe('isFailedResult (#110)', () => {
  const text = (value: string): ToolResultLike => ({
    isError: false,
    content: [{ type: 'text', text: value }],
  });

  it('reads the host error flag', () => {
    expect(isFailedResult({ isError: true, content: [] })).toBe(true);
  });

  it('reads the exit-code, kill, timeout and stop markers', () => {
    expect(isFailedResult(text('boom\n[exit code: 1]'))).toBe(true);
    expect(isFailedResult(text('boom\n[exit code: 130]'))).toBe(true);
    expect(isFailedResult(text('[killed by signal: SIGTERM]'))).toBe(true);
    expect(isFailedResult(text('[timed out after 600000ms]'))).toBe(true);
    expect(isFailedResult(text('[stopped: user]'))).toBe(true);
  });

  it('treats a plain success as success', () => {
    expect(isFailedResult(successResult)).toBe(false);
    expect(isFailedResult(text('[master abc1234] probe: x\n 1 file changed'))).toBe(false);
    // Zero is never emitted as a failure marker.
    expect(isFailedResult(text('[exit code: 0]'))).toBe(false);
  });
});

describe('installCommitReminder', () => {
  it('registers a tools/post-execute listener', () => {
    const { ctx, listeners } = makeCtx();
    installCommitReminder(ctx);
    expect(listeners['tools/post-execute']).toBeTypeOf('function');
  });
});

describe('sessionRecordReminderListener (#111)', () => {
  const exitExec = (sessionId?: string): ToolExecutionLike => ({
    name: 'exit_plan_mode',
    arguments: { plan: '# plan' },
    ...(sessionId === undefined
      ? {}
      : { agent: { session: { id: sessionId, header: { cwd: '/proj' } } } }),
  });

  afterEach(() => {
    resetSessionLedger();
  });

  it('appends the notice when the session recorded nothing', async () => {
    const next = vi.fn(() => Promise.resolve({ kind: 'accept' as const }));
    const decision = await sessionRecordReminderListener(
      exitExec('sess-1'),
      successResult,
      next
    );

    expect(next).not.toHaveBeenCalled();
    expect(decision.content?.[1]?.text).toBe(SESSION_RECORD_REMINDER);
    expect(decision.content?.[0]).toBe(successResult.content[0]);
  });

  it('stays silent once the session wrote to its own project', async () => {
    recordMintWrite('sess-1');
    const next = vi.fn(() => Promise.resolve({ kind: 'accept' as const }));
    const decision = await sessionRecordReminderListener(exitExec('sess-1'), successResult, next);

    expect(next).toHaveBeenCalled();
    expect(decision.content).toBeUndefined();
  });

  it('leaves a rejected exit alone', async () => {
    const failed: ToolResultLike = { isError: true, content: [{ type: 'text', text: 'keep planning' }] };
    const next = vi.fn(() => Promise.resolve({ kind: 'accept' as const }));
    await sessionRecordReminderListener(exitExec('sess-1'), failed, next);

    expect(next).toHaveBeenCalled();
  });

  it('says nothing it cannot attribute to a session', async () => {
    const next = vi.fn(() => Promise.resolve({ kind: 'accept' as const }));
    await sessionRecordReminderListener(exitExec(), successResult, next);

    expect(next).toHaveBeenCalled();
  });

  it('ignores every other tool', async () => {
    const next = vi.fn(() => Promise.resolve({ kind: 'accept' as const }));
    await sessionRecordReminderListener(
      { name: 'bash', arguments: { command: 'ls' }, agent: { session: { id: 'sess-1' } } },
      successResult,
      next
    );

    expect(next).toHaveBeenCalled();
  });
});

describe('installSessionRecordReminder', () => {
  it('registers a tools/post-execute listener', () => {
    const { ctx, listeners } = makeCtx();
    installSessionRecordReminder(ctx);
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
    expect(write).toHaveBeenCalledWith(expect.stringContaining('mint({args:["issue","add"'));
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
