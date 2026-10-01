import { beforeEach, describe, expect, it, vi } from 'vitest';

import { installCrossProjectGate, invocationsOf, sessionIdOf } from './cross-project-gate.js';
import { runMint } from './mint.js';
import type {
  ApprovalRequestLike,
  DshContext,
  PreToolDecisionLike,
  ToolExecutionLike,
} from './types.js';

vi.mock('./mint.js', () => ({ runMint: vi.fn() }));
const runMintMock = vi.mocked(runMint);

beforeEach(() => {
  runMintMock.mockReset();
  runMintMock.mockResolvedValue({ ok: true, text: '[{"name":"dsh-mint"},{"name":"other"}]' });
});

function makeCtx(): {
  ctx: DshContext;
  listeners: Record<string, (...args: never[]) => unknown>;
} {
  const listeners: Record<string, (...args: never[]) => unknown> = {};
  const ctx: DshContext = {
    on: (event, listener) => {
      listeners[event] = listener;
      return () => {};
    },
  };
  return { ctx, listeners };
}

type Pre = (
  exec: ToolExecutionLike,
  next: () => Promise<PreToolDecisionLike>
) => Promise<PreToolDecisionLike>;

type Approval = (req: ApprovalRequestLike, next: () => Promise<string>) => Promise<string>;

const pre = (listeners: Record<string, (...args: never[]) => unknown>): Pre =>
  listeners['tools/pre-execute'] as unknown as Pre;

const approval = (listeners: Record<string, (...args: never[]) => unknown>): Approval =>
  listeners['approval/request'] as unknown as Approval;

function mintExec(args: unknown, sessionId = 'sess-1', cwd = '/proj'): ToolExecutionLike {
  return {
    name: 'mint',
    arguments: { args },
    agent: { session: { id: sessionId, header: { cwd } } },
  };
}

function bashExec(command: string, sessionId = 'sess-1'): ToolExecutionLike {
  return {
    name: 'bash',
    arguments: { command },
    agent: { session: { id: sessionId, header: { cwd: '/proj' } } },
  };
}

const allowNext = (): (() => Promise<PreToolDecisionLike>) =>
  vi.fn(() => Promise.resolve({ kind: 'allow' as const }));

/** Ask+allow one cross-project write, as the host would. */
async function grant(
  listeners: Record<string, (...args: never[]) => unknown>,
  exec: ToolExecutionLike
): Promise<void> {
  const decision = await pre(listeners)(exec, allowNext());
  expect(decision.kind).toBe('ask');
  const outcome = await approval(listeners)(
    {
      toolName: exec.name,
      reason: decision.kind === 'ask' ? decision.reason : undefined,
      agent: exec.agent,
    },
    () => Promise.resolve('allowed-once')
  );
  expect(outcome).toBe('allowed-once');
}

describe('installCrossProjectGate', () => {
  it('registers the pre-execute decision and the approval bookkeeping', () => {
    const { ctx, listeners } = makeCtx();
    const dispose = installCrossProjectGate(ctx);
    expect(listeners['tools/pre-execute']).toBeTypeOf('function');
    expect(listeners['approval/request']).toBeTypeOf('function');
    expect(dispose).toBeTypeOf('function');
  });

  it('delegates every tool that carries no mint invocation', async () => {
    const { ctx, listeners } = makeCtx();
    installCrossProjectGate(ctx);
    const next = allowNext();
    const decision = await pre(listeners)(
      { name: 'read', arguments: { command: 'mint -p other issue add x' } },
      next
    );
    expect(decision.kind).toBe('allow');
    expect(next).toHaveBeenCalled();
    expect(runMintMock).not.toHaveBeenCalled();
  });

  it('lets a cross-project read through without asking', async () => {
    const { ctx, listeners } = makeCtx();
    installCrossProjectGate(ctx);
    const next = allowNext();
    const decision = await pre(listeners)(mintExec(['-p', 'other', 'list']), next);
    expect(decision.kind).toBe('allow');
    expect(next).toHaveBeenCalled();
    expect(runMintMock).toHaveBeenCalledWith('/proj', ['project', 'list', '--json'], {});
  });

  it('asks before the first cross-project write, naming project and action', async () => {
    const { ctx, listeners } = makeCtx();
    installCrossProjectGate(ctx);
    const next = allowNext();
    const decision = await pre(listeners)(
      mintExec(['-p', 'other', 'issue', 'state', 'start', '5']),
      next
    );
    expect(decision.kind).toBe('ask');
    if (decision.kind !== 'ask') throw new Error('expected an ask');
    expect(decision.reason).toContain('"other"');
    expect(decision.reason).toContain('issue state start 5');
    expect(decision.displayReason?.zh).toContain('目标项目：other');
    expect(decision.displayReason?.en).toContain('other');
    expect(next).not.toHaveBeenCalled();
  });

  it('passes the same write through after one grant, and asks again per project/session', async () => {
    const { ctx, listeners } = makeCtx();
    installCrossProjectGate(ctx);
    const write = ['-p', 'other', 'issue', 'add', 'title'];
    await grant(listeners, mintExec(write));

    // same session, same project → silent
    const next = allowNext();
    expect((await pre(listeners)(mintExec(write), next)).kind).toBe('allow');
    expect(next).toHaveBeenCalled();

    // same session, another project → asks again
    expect(
      (await pre(listeners)(mintExec(['-p', 'dsh-mint', ...write.slice(2)]), allowNext())).kind
    ).toBe('ask');

    // another session → asks again
    expect((await pre(listeners)(mintExec(write, 'sess-2'), allowNext())).kind).toBe('ask');
  });

  it('does not remember a rejected or cancelled approval', async () => {
    const { ctx, listeners } = makeCtx();
    installCrossProjectGate(ctx);
    const exec = mintExec(['-p', 'other', 'issue', 'add', 'title']);
    const decision = await pre(listeners)(exec, allowNext());
    expect(decision.kind).toBe('ask');
    await approval(listeners)(
      {
        toolName: 'mint',
        reason: decision.kind === 'ask' ? decision.reason : '',
        agent: exec.agent,
      },
      () => Promise.resolve('rejected')
    );
    expect((await pre(listeners)(exec, allowNext())).kind).toBe('ask');
  });

  it('refuses an unknown target project instead of asking', async () => {
    const { ctx, listeners } = makeCtx();
    installCrossProjectGate(ctx);
    runMintMock.mockResolvedValue({ ok: true, text: '[{"name":"dsh-mint"}]' });
    const next = allowNext();
    const decision = await pre(listeners)(mintExec(['-p', 'typo', 'issue', 'add', 'x']), next);
    expect(decision.kind).toBe('deny');
    if (decision.kind !== 'deny') throw new Error('expected a denial');
    expect(decision.reason).toContain('目标项目 "typo" 不存在');
    expect(decision.reason).toContain('dsh-mint');
    expect(next).not.toHaveBeenCalled();
  });

  it('refuses a cross-project call it cannot verify (fail-closed)', async () => {
    const { ctx, listeners } = makeCtx();
    installCrossProjectGate(ctx);
    runMintMock.mockResolvedValue({ ok: false, exitCode: 1, error: 'boom' });
    const decision = await pre(listeners)(mintExec(['-p', 'other', 'list']), allowNext());
    expect(decision.kind).toBe('deny');
    expect(decision.kind === 'deny' ? decision.reason : '').toContain('无法校验目标项目');
  });

  it('refuses when the probe itself throws', async () => {
    const { ctx, listeners } = makeCtx();
    installCrossProjectGate(ctx);
    runMintMock.mockRejectedValue(new Error('spawn failed'));
    expect((await pre(listeners)(mintExec(['-p', 'other', 'list']), allowNext())).kind).toBe(
      'deny'
    );
  });

  it('gates a recognised bash mint invocation through the same classifier', async () => {
    const { ctx, listeners } = makeCtx();
    installCrossProjectGate(ctx);
    // read → pass
    const readNext = allowNext();
    expect((await pre(listeners)(bashExec('mint -p other list'), readNext)).kind).toBe('allow');
    expect(readNext).toHaveBeenCalled();

    // write → ask
    const write = bashExec('mint -p other issue state start 5');
    expect((await pre(listeners)(write, allowNext())).kind).toBe('ask');
    await grant(listeners, write);
    const next = allowNext();
    expect((await pre(listeners)(write, next)).kind).toBe('allow');
    expect(next).toHaveBeenCalled();

    // a session-project mint command is not this gate's business
    const plain = allowNext();
    expect((await pre(listeners)(bashExec('mint issue state start 5'), plain)).kind).toBe('allow');
    expect(plain).toHaveBeenCalled();
  });

  it('passes an inline MINT_PROJECT write through the same gate', async () => {
    const { ctx, listeners } = makeCtx();
    installCrossProjectGate(ctx);
    const decision = await pre(listeners)(
      bashExec('MINT_PROJECT=other mint issue add title'),
      allowNext()
    );
    expect(decision.kind).toBe('ask');
    expect(decision.kind === 'ask' ? decision.reason : '').toContain('"other"');
  });

  it('delegates approvals whose reason this gate did not build', async () => {
    const { ctx, listeners } = makeCtx();
    installCrossProjectGate(ctx);
    const next = vi.fn(() => Promise.resolve('allowed-once'));
    await approval(listeners)(
      {
        toolName: 'bash',
        reason: 'escalate sandbox to danger-full-access: mint',
        agent: { id: 'a1', session: { id: 'sess-1' } },
      },
      next
    );
    expect(next).toHaveBeenCalledTimes(1);
    // no grant was recorded: a cross-project write still asks
    expect(
      (await pre(listeners)(mintExec(['-p', 'other', 'issue', 'add', 'x']), allowNext())).kind
    ).toBe('ask');
  });

  it('asks again when the approval carries no session identity', async () => {
    const { ctx, listeners } = makeCtx();
    installCrossProjectGate(ctx);
    const exec = mintExec(['-p', 'other', 'issue', 'add', 'title']);
    const decision = await pre(listeners)(exec, allowNext());
    await approval(listeners)(
      {
        toolName: 'mint',
        reason: decision.kind === 'ask' ? decision.reason : '',
        agent: { id: 'a1' },
      },
      () => Promise.resolve('allowed-once')
    );
    expect((await pre(listeners)(exec, allowNext())).kind).toBe('ask');
  });

  it('ignores argv the tool could not read as strings', async () => {
    const { ctx, listeners } = makeCtx();
    installCrossProjectGate(ctx);
    const next = allowNext();
    const decision = await pre(listeners)(mintExec(['-p', 'other', 42, 'issue', 'add', 'x']), next);
    expect(decision.kind).toBe('allow');
    expect(next).toHaveBeenCalled();
  });
});

describe('invocationsOf', () => {
  it('reads the mint tool argv and bash commands, nothing else', () => {
    expect(invocationsOf(mintExec(['list']))).toHaveLength(1);
    expect(invocationsOf(bashExec('mint list'))).toHaveLength(1);
    expect(invocationsOf({ name: 'mint', arguments: {} })).toEqual([]);
    expect(invocationsOf({ name: 'other', arguments: {} })).toEqual([]);
  });
});

describe('sessionIdOf', () => {
  it('reads only a stable session id', () => {
    expect(sessionIdOf({ session: { id: 'sess-1' } })).toBe('sess-1');
    expect(sessionIdOf({ id: 'a1' })).toBeUndefined();
    expect(sessionIdOf(undefined)).toBeUndefined();
    expect(sessionIdOf({ session: { id: 42 } })).toBeUndefined();
  });
});
