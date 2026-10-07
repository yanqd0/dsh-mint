import { afterEach, describe, expect, it } from 'vitest';

import {
  MAX_SESSIONS,
  hasMintWrite,
  installSessionLedger,
  isOwnProjectMintWrite,
  notePlanModeExit,
  notePlanModeState,
  planModeKnownState,
  recordMintWrite,
  resetSessionLedger,
  takeRecordGapNotice,
} from '../../../src/host/session-ledger.js';
import { noteOwnProject, resetOwnProjectCache } from '../../../src/mint/own-project.js';
import type {
  DshContext,
  SessionEventLike,
  SessionLike,
  ToolExecutionLike,
  ToolResultLike,
} from '../../../src/shared/types.js';

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
  resetOwnProjectCache();
});

describe('isOwnProjectMintWrite', () => {
  it('counts own-project writes from the tool and from bash', () => {
    expect(isOwnProjectMintWrite(mintExec(['issue', 'state', 'start', '42']), success)).toBe(true);
    expect(isOwnProjectMintWrite(mintExec(['plan', 'attach', '20', '113']), success)).toBe(true);
    expect(
      isOwnProjectMintWrite(bashExec('mint issue state commit 42 --sha abc1234'), success)
    ).toBe(true);
  });

  it('ignores reads, foreign tools and errored calls', () => {
    expect(isOwnProjectMintWrite(mintExec(['list']), success)).toBe(false);
    expect(isOwnProjectMintWrite(mintExec(['plan', 'list', '--json']), success)).toBe(false);
    expect(
      isOwnProjectMintWrite(
        { name: 'uv', arguments: { args: ['run', 'pytest'] }, agent: agent('s') },
        success
      )
    ).toBe(false);
    expect(isOwnProjectMintWrite(mintExec(['issue', 'state', 'start', '42']), failure)).toBe(false);
  });

  it('ignores cross-project writes: another ledger is not this session’s record', () => {
    expect(
      isOwnProjectMintWrite(mintExec(['-p', 'other', 'issue', 'state', 'start', '42']), success)
    ).toBe(false);
  });

  it('counts -p <本项目> as this session’s own record (#114)', () => {
    noteOwnProject('/proj', undefined, 'dsh-mint');

    expect(
      isOwnProjectMintWrite(mintExec(['-p', 'dsh-mint', 'issue', 'state', 'start', '42']), success)
    ).toBe(true);
    // A real cross-project write still does not count.
    expect(
      isOwnProjectMintWrite(mintExec(['-p', 'other', 'issue', 'state', 'start', '42']), success)
    ).toBe(false);
  });

  it('treats -p <本项目> as foreign while the own project is unknown (#114)', () => {
    expect(
      isOwnProjectMintWrite(mintExec(['-p', 'dsh-mint', 'issue', 'state', 'start', '42']), success)
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
    notePlanModeExit('sess-1');
    resetSessionLedger();
    expect(hasMintWrite('sess-1')).toBe(false);
    expect(takeRecordGapNotice('sess-1')).toBe(false);
  });

  it('keeps the observed plan-mode state bounded, exclusive and resettable (#142)', () => {
    expect(planModeKnownState('sess-1')).toBeUndefined();
    notePlanModeState(undefined, true);
    expect(planModeKnownState(undefined)).toBeUndefined();

    notePlanModeState('sess-1', true);
    expect(planModeKnownState('sess-1')).toBe(true);
    // The last value wins: the two directions are one slot, not two facts.
    notePlanModeState('sess-1', false);
    expect(planModeKnownState('sess-1')).toBe(false);

    for (let index = 0; index < MAX_SESSIONS + 5; index += 1) {
      notePlanModeState(`s-${index}`, true);
    }
    expect(planModeKnownState('s-0')).toBeUndefined();

    resetSessionLedger();
    expect(planModeKnownState('sess-1')).toBeUndefined();
    expect(planModeKnownState(`s-${MAX_SESSIONS + 4}`)).toBeUndefined();
  });

  // #116: the plan-mode exit is a session event, and the notice behind it is
  // one-shot per session and closed by any own-project mint write.
  it('hands out the record-gap notice once, only after a plan-mode exit (#116)', () => {
    expect(takeRecordGapNotice('sess-1')).toBe(false);

    notePlanModeExit('sess-1');
    expect(takeRecordGapNotice('sess-1')).toBe(true);
    expect(takeRecordGapNotice('sess-1')).toBe(false);
    expect(takeRecordGapNotice('sess-2')).toBe(false);
    expect(takeRecordGapNotice(undefined)).toBe(false);

    notePlanModeExit(undefined);
    expect(takeRecordGapNotice(undefined)).toBe(false);
  });

  it('keeps the notice silent for a session that recorded its work (#116)', () => {
    notePlanModeExit('sess-1');
    recordMintWrite('sess-1');

    expect(takeRecordGapNotice('sess-1')).toBe(false);
  });
});

describe('installSessionLedger', () => {
  function makeCtx(): {
    ctx: DshContext;
    emitResult: (exec: ToolExecutionLike, result: ToolResultLike) => void;
    emitEvent: (session: SessionLike, event: SessionEventLike) => void;
  } {
    let listener: ((exec: ToolExecutionLike, result: ToolResultLike) => void) | undefined;
    let eventListener: ((session: SessionLike, event: SessionEventLike) => void) | undefined;
    const ctx: DshContext = {
      on: (event, fn) => {
        if (event === 'tools/result') {
          listener = fn as (exec: ToolExecutionLike, result: ToolResultLike) => void;
        }
        if (event === 'session/event') {
          eventListener = fn as (session: SessionLike, event: SessionEventLike) => void;
        }
        return () => {};
      },
    };
    return {
      ctx,
      emitResult: (exec, result) => listener?.(exec, result),
      emitEvent: (session, event) => eventListener?.(session, event),
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

  it('reads a plan-mode exit off the session log (#116)', () => {
    const { ctx, emitEvent } = makeCtx();
    installSessionLedger(ctx);

    emitEvent({ id: 'sess-7' }, { type: 'plan/mode', data: { active: false } });

    expect(takeRecordGapNotice('sess-7')).toBe(true);
  });

  it('ignores every other session event, and entering plan mode (#116)', () => {
    const { ctx, emitEvent } = makeCtx();
    installSessionLedger(ctx);

    emitEvent({ id: 'sess-7' }, { type: 'turn/start', data: {} });
    emitEvent({ id: 'sess-7' }, { type: 'plan/mode', data: { active: true } });
    emitEvent({ id: 'sess-7' }, {});
    emitEvent({}, { type: 'plan/mode', data: { active: false } });

    expect(takeRecordGapNotice('sess-7')).toBe(false);
  });

  it('records both plan-mode directions off the session log (#142)', () => {
    const { ctx, emitEvent } = makeCtx();
    installSessionLedger(ctx);

    expect(planModeKnownState('sess-7')).toBeUndefined();
    emitEvent({ id: 'sess-7' }, { type: 'plan/mode', data: { active: true } });
    expect(planModeKnownState('sess-7')).toBe(true);
    // Entering plan mode is still not a *record gap* (#116), only a state (#142).
    expect(takeRecordGapNotice('sess-7')).toBe(false);

    emitEvent({ id: 'sess-7' }, { type: 'plan/mode', data: { active: false } });
    expect(planModeKnownState('sess-7')).toBe(false);
    expect(takeRecordGapNotice('sess-7')).toBe(true);

    // A payload without a boolean `active` is not evidence of either direction.
    emitEvent({ id: 'sess-8' }, { type: 'plan/mode', data: {} });
    expect(planModeKnownState('sess-8')).toBeUndefined();
  });

  it('treats an unreadable event as no evidence (#116)', () => {
    const { ctx, emitEvent } = makeCtx();
    installSessionLedger(ctx);
    const frozen = Object.defineProperty({}, 'type', {
      get() {
        throw new Error('frozen');
      },
    });

    expect(() => emitEvent({ id: 'sess-7' }, frozen)).not.toThrow();
    expect(takeRecordGapNotice('sess-7')).toBe(false);
  });
});
