import { describe, expect, it, vi } from 'vitest';

import { installApprovalGate, isMintCommand, isMintEscalation } from './approval-gate.js';
import type { ApprovalRequestLike, DshContext, ToolExecutionLike, ToolResultLike } from './types.js';

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

const okResult: ToolResultLike = { isError: false, content: [] };

const mintReason = 'escalate sandbox to danger-full-access: mint';
const mintReq = (over: Partial<ApprovalRequestLike> = {}): ApprovalRequestLike => ({
  toolName: 'bash',
  callId: 'call-1',
  reason: mintReason,
  agent: { id: 'a1' },
  ...over,
});

/** Record a bash command as the pre-execute listener would. */
function recordBash(
  listeners: Record<string, (...args: unknown[]) => unknown>,
  callId: string,
  command: string,
): void {
  const pre = listeners['tools/pre-execute'] as (
    exec: ToolExecutionLike,
    next: () => Promise<{ kind: 'allow' }>,
  ) => Promise<{ kind: 'allow' }>;
  const next = vi.fn(() => Promise.resolve({ kind: 'allow' as const }));
  void pre({ name: 'bash', callId, arguments: { command } }, next);
}

function approval(
  listeners: Record<string, (...args: unknown[]) => unknown>,
): (req: ApprovalRequestLike, next: () => Promise<string>) => Promise<string> {
  return listeners['approval/request'] as (
    req: ApprovalRequestLike,
    next: () => Promise<string>,
  ) => Promise<string>;
}

describe('isMintCommand', () => {
  const cases: Array<[string, boolean]> = [
    ['mint', true],
    ['mint list', true],
    ['mint list --no-page -a', true],
    [' mint list', true],
    ['mint\tlist', true],
    ['mint issue state start 25', true],
    ['mint plan list --milestone 1', true],
    ['MINT_DB_PATH=/tmp/x.db mint list', false],
    ['mint; echo hi', false],
    ['mint && echo hi', false],
    ['mint | grep x', false],
    ['mint "list"', false],
    ["mint list --milestone ''", false],
    ['mint list # comment', false],
    ['cd /tmp && mint list', false],
    ['minty list', false],
    ['echo mint', false],
  ];
  it.each(cases)('matches %j as %s', (command, expected) => {
    expect(isMintCommand(command)).toBe(expected);
  });
});

describe('isMintEscalation', () => {
  it('recognizes only bash escalations to the widest mode', () => {
    expect(isMintEscalation(mintReason)).toBe(true);
    expect(isMintEscalation('escalate sandbox to danger-full-access: other tool')).toBe(true);
    expect(isMintEscalation('escalate sandbox to workspace-write: x')).toBe(false);
    expect(isMintEscalation('pre-execute ask for bash')).toBe(false);
    expect(isMintEscalation(undefined)).toBe(false);
  });
});

describe('installApprovalGate', () => {
  it('registers pre-execute, post-execute and approval/request listeners', () => {
    const { ctx, listeners } = makeCtx();
    installApprovalGate(ctx, {});
    expect(listeners['tools/pre-execute']).toBeTypeOf('function');
    expect(listeners['tools/post-execute']).toBeTypeOf('function');
    expect(listeners['approval/request']).toBeTypeOf('function');
  });

  it('delegates when the tool is not bash', async () => {
    const { ctx, listeners } = makeCtx();
    installApprovalGate(ctx, {});
    const next = vi.fn(() => Promise.resolve('rejected'));
    const outcome = await approval(listeners)(mintReq({ toolName: 'read' }), next);
    expect(outcome).toBe('rejected');
    expect(next).toHaveBeenCalled();
  });

  it('delegates without a callId or a non-escalation reason', async () => {
    const { ctx, listeners } = makeCtx();
    installApprovalGate(ctx, {});
    const next = vi.fn(() => Promise.resolve('unavailable'));

    expect(await approval(listeners)(mintReq({ callId: undefined }), next)).toBe('unavailable');
    expect(await approval(listeners)(mintReq({ reason: 'some other ask' }), next)).toBe(
      'unavailable',
    );
    expect(next).toHaveBeenCalledTimes(2);
  });

  it('delegates when the correlated command is not a bare mint invocation', async () => {
    const { ctx, listeners } = makeCtx();
    installApprovalGate(ctx, {});
    recordBash(listeners, 'call-1', 'rm -rf ~');
    const next = vi.fn(() => Promise.resolve('allowed-once'));
    expect(await approval(listeners)(mintReq(), next)).toBe('allowed-once');
    // delegated to the chain (which allowed) — the gate itself did not grant
    expect(next).toHaveBeenCalled();
  });

  it('delegates when no command was correlated (unknown callId)', async () => {
    const { ctx, listeners } = makeCtx();
    installApprovalGate(ctx, {});
    const next = vi.fn(() => Promise.resolve('allowed-once'));
    expect(await approval(listeners)(mintReq({ callId: 'ghost' }), next)).toBe('allowed-once');
    expect(next).toHaveBeenCalled();
  });

  it('remembers an allowed-once mint grant per agent session and auto-allows after', async () => {
    const { ctx, listeners } = makeCtx();
    installApprovalGate(ctx, {});
    recordBash(listeners, 'call-1', 'mint list');
    recordBash(listeners, 'call-2', 'mint issue show 1');

    // the runtime may hand a *different* Agent object per dispatch, but the
    // session id is stable — the grant must key on session.id, not the object
    const agentA = { id: 'a1', session: { id: 'sess-1' } };
    const agentB = { id: 'a1', session: { id: 'sess-1' } }; // different object, same session
    const next = vi.fn(() => Promise.resolve('allowed-once'));
    expect(await approval(listeners)(mintReq({ agent: agentA }), next)).toBe('allowed-once');
    expect(next).toHaveBeenCalledTimes(1);

    // second ask for the same session via a different object: immediate grant
    expect(await approval(listeners)(mintReq({ callId: 'call-2', agent: agentB }), next)).toBe(
      'allowed-once',
    );
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('does not leak a grant across different agent sessions', async () => {
    const { ctx, listeners } = makeCtx();
    installApprovalGate(ctx, {});
    recordBash(listeners, 'call-1', 'mint list');
    recordBash(listeners, 'call-2', 'mint list');
    const next = vi.fn(() => Promise.resolve('allowed-once'));
    expect(
      await approval(listeners)(mintReq({ agent: { id: 'a1', session: { id: 'sess-A' } } }), next),
    ).toBe('allowed-once');
    expect(next).toHaveBeenCalledTimes(1);
    // different session must still delegate
    expect(
      await approval(listeners)(
        mintReq({ callId: 'call-2', agent: { id: 'a2', session: { id: 'sess-B' } } }),
        next,
      ),
    ).toBe('allowed-once');
    expect(next).toHaveBeenCalledTimes(2);
  });

  it('falls back to the standardised justification when no command is correlated', async () => {
    const { ctx, listeners } = makeCtx();
    installApprovalGate(ctx, {});
    // no tools/pre-execute recorded (correlation unavailable) — reason says "mint"
    const agent = { id: 'a1', session: { id: 'sess-1' } };
    const next = vi.fn(() => Promise.resolve('allowed-once'));
    expect(await approval(listeners)(mintReq({ agent }), next)).toBe('allowed-once');
    expect(next).toHaveBeenCalledTimes(1);
    // follow-up without correlation is auto-allowed from the grant
    expect(
      await approval(listeners)(mintReq({ callId: 'call-2', agent: { ...agent } }), next),
    ).toBe('allowed-once');
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('does not auto-allow a correlated non-mint command even after a mint grant', async () => {
    const { ctx, listeners } = makeCtx();
    installApprovalGate(ctx, {});
    recordBash(listeners, 'call-1', 'mint list');
    recordBash(listeners, 'call-2', 'rm -rf ~');
    const agent = { id: 'a1', session: { id: 'sess-1' } };
    const next = vi.fn(() => Promise.resolve('allowed-once'));
    expect(await approval(listeners)(mintReq({ agent }), next)).toBe('allowed-once');
    expect(next).toHaveBeenCalledTimes(1);
    // grant exists, but the correlated command is NOT bare mint → must delegate
    expect(await approval(listeners)(mintReq({ callId: 'call-2', agent }), next)).toBe(
      'allowed-once',
    );
    expect(next).toHaveBeenCalledTimes(2);
  });

  it('does not remember a rejected grant', async () => {
    const { ctx, listeners } = makeCtx();
    installApprovalGate(ctx, {});
    recordBash(listeners, 'call-1', 'mint list');

    const next = vi.fn(() => Promise.resolve('rejected'));
    expect(await approval(listeners)(mintReq(), next)).toBe('rejected');

    // rejected: the gate must keep delegating subsequent asks
    expect(await approval(listeners)(mintReq(), next)).toBe('rejected');
    expect(next).toHaveBeenCalledTimes(2);
  });

  it('auto-allows the first ask when autoApprove is enabled', async () => {
    const { ctx, listeners } = makeCtx();
    installApprovalGate(ctx, { autoApprove: true });
    recordBash(listeners, 'call-1', 'mint list');

    const next = vi.fn(() => Promise.resolve('unavailable'));
    expect(await approval(listeners)(mintReq(), next)).toBe('allowed-once');
    expect(next).not.toHaveBeenCalled();
  });

  it('fails open to delegation when the request itself throws', async () => {
    const { ctx, listeners } = makeCtx();
    installApprovalGate(ctx, {});
    const next = vi.fn(() => Promise.resolve('allowed-once'));
    const evil: ApprovalRequestLike = { toolName: 'bash' };
    Object.defineProperty(evil, 'toolName', {
      get(): string {
        throw new Error('boom');
      },
    });
    expect(await approval(listeners)(evil, next)).toBe('allowed-once');
    expect(next).toHaveBeenCalled();
  });

  it('clears the correlation after post-execute', async () => {
    const { ctx, listeners } = makeCtx();
    installApprovalGate(ctx, {});
    recordBash(listeners, 'call-1', 'mint list');

    const post = listeners['tools/post-execute'] as (
      exec: ToolExecutionLike,
      result: ToolResultLike,
      next: () => Promise<{ kind: 'accept' }>,
    ) => Promise<{ kind: 'accept' }>;
    void post({ name: 'bash', callId: 'call-1', arguments: {} }, okResult, () =>
      Promise.resolve({ kind: 'accept' }),
    );

    const next = vi.fn(() => Promise.resolve('allowed-once'));
    expect(await approval(listeners)(mintReq(), next)).toBe('allowed-once');
    expect(next).toHaveBeenCalled();
  });

  it('ignores non-bash calls in the correlation map', async () => {
    const { ctx, listeners } = makeCtx();
    installApprovalGate(ctx, {});
    const pre = listeners['tools/pre-execute'] as (
      exec: ToolExecutionLike,
      next: () => Promise<{ kind: 'allow' }>,
    ) => Promise<{ kind: 'allow' }>;
    void pre(
      { name: 'read', callId: 'call-1', arguments: { command: 'mint list' } },
      () => Promise.resolve({ kind: 'allow' }),
    );

    const next = vi.fn(() => Promise.resolve('allowed-once'));
    expect(await approval(listeners)(mintReq(), next)).toBe('allowed-once');
    expect(next).toHaveBeenCalled();
  });
});
