import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { applyDagWrite, emptyDag } from './dag.js';
import { updateDag } from './dag-store.js';
import {
  installWorktreeSweep,
  outstandingWorktrees,
  worktreeSweepListener,
  worktreeSweepReminder,
} from './dag-worktree-sweep.js';
import type { DagNodeView } from './records.js';
import type { DshContext, PostToolDecisionLike, ToolExecutionLike, ToolResultLike } from './types.js';

/**
 * The plan-close worktree sweep (#175).
 *
 * The DAG document is read through the real store from a temp directory, so the
 * path validation and the document shape are real; the trigger is the one thing
 * faked (a tool call named like the mint tool carrying `plan close`).
 */
let dagDir: string;

/** A tool call that asks mint to close a plan. */
function closeExec(sessionId = 'sess-1'): ToolExecutionLike {
  return {
    name: 'mint',
    arguments: { args: ['plan', 'close', '36', '--test-cmd', 'pnpm test'] },
    agent: { session: { id: sessionId, header: { cwd: '/proj' } } },
  };
}

const successResult: ToolResultLike = { isError: false, content: [{ type: 'text', text: 'ok' }] };
const next = (): Promise<PostToolDecisionLike> => Promise.resolve({ kind: 'accept' });

/** Write one node carrying a worktree state into the session's document. */
async function seed(session: string, state: 'active' | 'merged' | 'conflict' | 'removed'): Promise<void> {
  const now = '2026-01-01T00:00:00.000Z';
  const withNode = applyDagWrite(
    {
      action: 'add',
      nodes: [{ id: 'a1', label: '①', title: 'work', phase: 'exec', depends_on: [] }],
      edges: [],
    },
    emptyDag(session, 'wt', now),
    session,
    now
  );
  if ('error' in withNode) throw new Error(withNode.error);
  const first = await updateDag(session, () => ({ doc: withNode.doc }), dagDir);
  expect(first.ok).toBe(true);
  const second = await updateDag(
    session,
    (read) => {
      if (read.state !== 'ok') throw new Error('seed: no document');
      const outcome = applyDagWrite(
        {
          action: 'set',
          id: 'a1',
          status: 'done',
          verdict: 'pass',
          worktree: {
            path: '/proj/.worktrees/s/a1',
            branch: 'dsh-mint/wt/s/a1',
            base: 'abc123',
            state,
          },
        },
        read.doc,
        session,
        now
      );
      if ('error' in outcome) throw new Error(outcome.error);
      return { doc: outcome.doc };
    },
    dagDir
  );
  expect(second.ok).toBe(true);
}

beforeEach(() => {
  dagDir = mkdtempSync(join(tmpdir(), 'dsh-mint-wt-sweep-'));
});

afterEach(() => {
  rmSync(dagDir, { recursive: true, force: true });
});

describe('outstandingWorktrees (#175)', () => {
  const node = (id: string, state: 'active' | 'merged' | 'conflict' | 'removed'): DagNodeView =>
    ({
      id,
      label: id,
      title: id,
      phase: 'exec',
      status: 'done',
      depends_on: [],
      worktree: { path: `/p/${id}`, branch: `b/${id}`, base: 'abc', state },
      updated_at: '2026-01-01T00:00:00.000Z',
    }) satisfies DagNodeView;

  it('lists every worktree that is still on disk, not-removed', () => {
    // `exactOptionalPropertyTypes`: a node without a worktree omits the key
    // entirely rather than carrying `undefined` (the stored shape has no key).
    const withoutWorktree: DagNodeView = {
      id: 'd',
      label: 'd',
      title: 'd',
      phase: 'exec',
      status: 'done',
      depends_on: [],
      updated_at: '2026-01-01T00:00:00.000Z',
    };
    const kept = outstandingWorktrees([
      node('a', 'active'),
      node('b', 'merged'),
      node('c', 'removed'),
      withoutWorktree,
    ]);
    expect(kept.map((entry) => entry.id)).toEqual(['a', 'b']);
  });

  it('names node, state and branch in the reminder', () => {
    const text = worktreeSweepReminder([node('a', 'conflict')]);
    expect(text).toContain('a conflict');
    expect(text).toContain('b/a');
    expect(text).toContain('wt",op:"remove"');
  });
});

describe('worktreeSweepListener (#175)', () => {
  it('appends the leftover list after a successful plan close', async () => {
    await seed('sess-1', 'merged');

    const decision = await worktreeSweepListener(closeExec(), successResult, next, dagDir);

    expect(decision.kind).toBe('accept');
    expect(decision.content?.[0]).toEqual({ type: 'text', text: 'ok' });
    const text = decision.content?.map((block) => block.text).join('\n') ?? '';
    expect(text).toContain('a1');
    expect(text).toContain('dsh-mint/wt/s/a1');
  });

  it('stays quiet when every worktree was removed', async () => {
    await seed('sess-1', 'removed');
    const spy = vi.fn(next);

    const decision = await worktreeSweepListener(closeExec(), successResult, spy, dagDir);

    expect(spy).toHaveBeenCalled();
    expect(decision).toEqual({ kind: 'accept' });
    expect(decision.content).toBeUndefined();
  });

  it('stays quiet for other mint calls, failures, and subagents', async () => {
    await seed('sess-1', 'active');

    const other: ToolExecutionLike = {
      name: 'mint',
      arguments: { args: ['issue', 'state', 'start', '42'] },
      agent: { session: { id: 'sess-1', header: { cwd: '/proj' } } },
    };
    const spyOther = vi.fn(next);
    expect(await worktreeSweepListener(other, successResult, spyOther, dagDir)).toEqual({ kind: 'accept' });
    expect(spyOther).toHaveBeenCalled();

    const spyFailed = vi.fn(next);
    const failed: ToolResultLike = { isError: false, content: [{ type: 'text', text: 'boom\n[exit code: 1]' }] };
    expect(await worktreeSweepListener(closeExec(), failed, spyFailed, dagDir)).toEqual({ kind: 'accept' });
    expect(spyFailed).toHaveBeenCalled();

    const child: ToolExecutionLike = {
      ...closeExec(),
      agent: { session: { id: 'sess-1', header: { cwd: '/proj', delegationDepth: 1 } } },
    };
    const spyChild = vi.fn(next);
    expect(await worktreeSweepListener(child, successResult, spyChild, dagDir)).toEqual({ kind: 'accept' });
    expect(spyChild).toHaveBeenCalled();
  });

  it('stays quiet without a DAG or a session id', async () => {
    const spyNoDag = vi.fn(next);
    expect(await worktreeSweepListener(closeExec('sess-none'), successResult, spyNoDag, dagDir)).toEqual({
      kind: 'accept',
    });
    expect(spyNoDag).toHaveBeenCalled();

    await seed('sess-1', 'active');
    const anonymous: ToolExecutionLike = { name: 'mint', arguments: { args: ['plan', 'close', '36'] } };
    const spy = vi.fn(next);
    expect(await worktreeSweepListener(anonymous, successResult, spy, dagDir)).toEqual({ kind: 'accept' });
    expect(spy).toHaveBeenCalled();
  });
});

describe('installWorktreeSweep (#175)', () => {
  it('registers a tools/post-execute listener that reads the DAG directory', async () => {
    await seed('sess-1', 'active');
    const listeners: Record<string, unknown> = {};
    const ctx: DshContext = {
      on: (event, listener) => {
        listeners[event] = listener;
        return () => {};
      },
    };
    installWorktreeSweep(ctx, dagDir);

    const listener = listeners['tools/post-execute'] as (
      exec: ToolExecutionLike,
      result: ToolResultLike,
      next: () => Promise<PostToolDecisionLike>
    ) => Promise<PostToolDecisionLike>;
    expect(listener).toBeTypeOf('function');
    const decision = await listener(closeExec(), successResult, next);
    expect(decision.content?.map((block) => block.text).join('\n')).toContain('a1');
  });
});
