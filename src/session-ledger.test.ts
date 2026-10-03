import { afterEach, describe, expect, it } from 'vitest';

import {
  MAX_SESSIONS,
  hasMintWrite,
  installSessionLedger,
  isOwnProjectMintWrite,
  recordMintWrite,
  resetSessionLedger,
} from './session-ledger.js';
import type { DshContext, ToolExecutionLike, ToolResultLike } from './types.js';

const success: ToolResultLike = { isError: false, content: [{ type: 'text', text: 'ok' }] };
const failure: ToolResultLike = { isError: true, content: [] };

function agent(sessionId: string): NonNullable<ToolExecutionLike['agent']> {
  return { session: { id: sessionId, header: { cwd: '/proj' } } };
}

function mintExec(argv: string[], sessionId = 'sess-1'): ToolExecutionLike {
  return { name: 'mint', arguments: { args: argv }, agent: agent(sessionId) };
}

function bashExec(command: string, sessionId = 'sess-1'): ToolExecutionLike {
  return { name: 'bash', arguments: { command }, agent: agent(sessionId) };
}

afterEach(() => {
  resetSessionLedger();
});

describe('isOwnProjectMintWrite', () => {
  it('counts own-project writes from the tool and from bash', () => {
    expect(isOwnProjectMintWrite(mintExec(['issue', 'state', 'start', '42']), success)).toBe(true);
    expect(isOwnProjectMintWrite(mintExec(['plan', 'attach', '20', '113']), success)).toBe(true);
    expect(isOwnProjectMintWrite(bashExec('mint issue state commit 42 --sha abc1234'), success)).toBe(
      true
    );
  });

  it('ignores reads, foreign tools and errored calls', () => {
    expect(isOwnProjectMintWrite(mintExec(['list']), success)).toBe(false);
    expect(isOwnProjectMintWrite(mintExec(['plan', 'list', '--json']), success)).toBe(false);
    expect(isOwnProjectMintWrite({ name: 'uv', arguments: { args: ['run', 'pytest'] }, agent: agent('s') }, success)).toBe(
      false
    );
    expect(isOwnProjectMintWrite(mintExec(['issue', 'state', 'start', '42']), failure)).toBe(false);
  });

  it('ignores cross-project writes: another ledger is not this session’s record', () => {
    expect(
      isOwnProjectMintWrite(mintExec(['-p', 'other', 'issue', 'state', 'start', '42']), success)
    ).toBe(false);
  });

  it('treats an unreadable call as no evidence', () => {
    const exec = {
      name: 'mint',
      arguments: {
        get args(): unknown {
          throw new Error('frozen');
        },
      },
    };
    expect(isOwnProjectMintWrite(exec, success)).toBe(false);
  });
});

describe('session ledger', () => {
  it('remembers a session once and answers per session', () => {
    expect(hasMintWrite('sess-1')).toBe(false);
    recordMintWrite('sess-1');
    recordMintWrite('sess-1');
    expect(hasMintWrite('sess-1')).toBe(true);
    expect(hasMintWrite('sess-2')).toBe(false);
    expect(hasMintWrite(undefined)).toBe(false);
    recordMintWrite(undefined);
    expect(hasMintWrite(undefined)).toBe(false);
  });

  it('keeps the map bounded', () => {
    for (let index = 0; index < MAX_SESSIONS + 5; index += 1) {
      recordMintWrite(`sess-${index}`);
    }
    expect(hasMintWrite('sess-0')).toBe(false);
    expect(hasMintWrite(`sess-${MAX_SESSIONS + 4}`)).toBe(true);
  });

  it('resets for tests', () => {
    recordMintWrite('sess-1');
    resetSessionLedger();
    expect(hasMintWrite('sess-1')).toBe(false);
  });
});

describe('installSessionLedger', () => {
  function makeCtx(): {
    ctx: DshContext;
    emitResult: (exec: ToolExecutionLike, result: ToolResultLike) => void;
  } {
    let listener: ((exec: ToolExecutionLike, result: ToolResultLike) => void) | undefined;
    const ctx: DshContext = {
      on: (event, fn) => {
        if (event === 'tools/result') {
          listener = fn as (exec: ToolExecutionLike, result: ToolResultLike) => void;
        }
        return () => {};
      },
    };
    return {
      ctx,
      emitResult: (exec, result) => listener?.(exec, result),
    };
  }

  it('observes tools/result and records the calling session', () => {
    const { ctx, emitResult } = makeCtx();
    installSessionLedger(ctx);

    emitResult(mintExec(['issue', 'state', 'start', '42'], 'sess-7'), success);

    expect(hasMintWrite('sess-7')).toBe(true);
  });

  it('records nothing for a read or an unattributable call', () => {
    const { ctx, emitResult } = makeCtx();
    installSessionLedger(ctx);

    emitResult(mintExec(['list'], 'sess-7'), success);
    emitResult({ name: 'mint', arguments: { args: ['issue', 'state', 'start', '42'] } }, success);

    expect(hasMintWrite('sess-7')).toBe(false);
  });

  it('counts a mint domain failure as a touch, but not a host-level error', () => {
    const { ctx, emitResult } = makeCtx();
    installSessionLedger(ctx);

    // `ok: false` from mint reaches the host as a *successful* tool call (the
    // model reads the error and recovers), and the session did touch the ledger.
    emitResult(mintExec(['plan', 'create', 'x', '--milestone', '4'], 'sess-8'), success);
    expect(hasMintWrite('sess-8')).toBe(true);

    emitResult(mintExec(['issue', 'state', 'start', '42'], 'sess-9'), failure);
    expect(hasMintWrite('sess-9')).toBe(false);
  });
});
