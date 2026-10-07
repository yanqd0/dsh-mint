import { existsSync, readFileSync } from 'node:fs';

import { describe, expect, it, vi, beforeEach } from 'vitest';

import { DAG_DIR } from './dag-store.js';
import { apply, inject, name } from './index.js';
import { installSkill } from './install-skill.js';
import { runMint } from './mint.js';
import type { DshContext, EventListener } from './types.js';

vi.mock('./mint.js', () => ({ runMint: vi.fn() }));
vi.mock('./install-skill.js', () => ({ installSkill: vi.fn(() => ({ ok: true })) }));
const runMintMock = vi.mocked(runMint);
const installSkillMock = vi.mocked(installSkill);

beforeEach(() => {
  runMintMock.mockReset();
  installSkillMock.mockReset();
});

describe('dsh-mint plugin', () => {
  it('exposes the plugin name', () => {
    expect(name).toBe('dsh-mint');
  });

  it('declares the services it consumes via inject', () => {
    expect(inject).toEqual(['tools']);
  });

  it('registers the agent lifecycle listeners (#113)', () => {
    const events: string[] = [];
    const ctx: DshContext = {
      on: (event) => {
        events.push(event);
        return () => {};
      },
    };
    apply(ctx, { debug: false, autoApprove: false, autoInstallSkill: true, openDagTab: true });
    // `agent/created` is the host's event; the older name stays as a fallback.
    expect(events).toContain('agent/created');
    expect(events).toContain('agent/session-start');
    // #116: a non-tool plan-mode exit is read off the session log.
    expect(events).toContain('session/event');
    // plan 31: the two subagent events pair a delegated run with its DAG node.
    expect(events).toContain('subagent/start');
    expect(events).toContain('subagent/end');
  });

  it('syncs the bundled skill on load unless autoInstallSkill is false (#28)', () => {
    const ctx: DshContext = {
      on: () => () => {},
    };
    apply(ctx, { debug: false, autoApprove: false, autoInstallSkill: true, openDagTab: true });
    expect(installSkillMock).toHaveBeenCalledTimes(1);

    apply(ctx, { debug: false, autoApprove: false, autoInstallSkill: false, openDagTab: true });
    expect(installSkillMock).toHaveBeenCalledTimes(1);
  });

  it('registers the approval gate seams (B-v2, #25)', () => {
    const events: string[] = [];
    const ctx: DshContext = {
      on: (event) => {
        events.push(event);
        return () => {};
      },
    };
    apply(ctx, { debug: false, autoApprove: false, autoInstallSkill: true, openDagTab: true });
    expect(events).toContain('approval/request');
    expect(events).toContain('tools/pre-execute');
    expect(events).toContain('tools/post-execute');
  });

  it('registers the mint overview on the agent ctx at agent creation (#113)', () => {
    const listeners: Record<string, EventListener> = {};
    const ctx: DshContext = {
      on: (event, listener) => {
        listeners[event] = listener;
        return () => {};
      },
    };
    apply(ctx, { debug: false, autoApprove: false, autoInstallSkill: true, openDagTab: true });

    const registered: Array<{ name: string; order: number; text: string | (() => string) }> = [];
    const agentCtx: DshContext = {
      on: () => () => {},
      systemPrompt: {
        context: (spec) => {
          registered.push(spec);
          return () => {};
        },
      },
    };
    const onCreate = listeners['agent/created'];
    expect(onCreate).toBeTypeOf('function');
    (onCreate as (payload: { agent?: { ctx: DshContext; session: { header: { cwd?: string } } } }) => void)({
      agent: { ctx: agentCtx, session: { header: { cwd: '/proj' } } },
    });

    expect(registered.map((r) => r.name)).toEqual(['mint:overview', 'mint:tool-guidance']);
  });

  it('skips registration without an agent payload', () => {
    const listeners: Record<string, EventListener> = {};
    const ctx: DshContext = {
      on: (event, listener) => {
        listeners[event] = listener;
        return () => {};
      },
    };
    apply(ctx, { debug: false, autoApprove: false, autoInstallSkill: true, openDagTab: true });
    const onCreate = listeners['agent/created'];
    expect(() =>
      (onCreate as (payload: { agent?: unknown }) => void)({}),
    ).not.toThrow();
    expect(runMintMock).not.toHaveBeenCalled();
  });

  it('registers the plan DAG tool next to mint (plan #31)', () => {
    const names: string[] = [];
    const ctx: DshContext = {
      on: () => () => {},
      tools: {
        register: (definition) => {
          names.push(definition.name);
          return () => {};
        },
      },
    };
    apply(ctx, { debug: false, autoApprove: false, autoInstallSkill: true, openDagTab: true });
    expect(names).toEqual(['mint', 'mint_plan_dag']);
  });

  it('pairs a subagent run with a node of its parent DAG (plan #31)', async () => {
    const listeners: Record<string, EventListener> = {};
    const ctx: DshContext = {
      on: (event, listener) => {
        listeners[event] = listener;
        return () => {};
      },
      // `apply` installs the lifecycle over the shipped `/tmp/mint/dag`
      // directory, so this test must not point it at a graph: its only writes
      // need a node that is running *and* unassigned (asserted below).
      get: () => ({ get: () => ({ session: { header: { parentSession: 'root' } } }) }),
    };
    apply(ctx, { debug: false, autoApprove: false, autoInstallSkill: true, openDagTab: true });
    const onStart = listeners['subagent/start'];
    const onEnd = listeners['subagent/end'];
    expect(onStart).toBeTypeOf('function');
    expect(onEnd).toBeTypeOf('function');

    const file = `${DAG_DIR}/root.json`;
    const before = existsSync(file) ? readFileSync(file, 'utf8') : undefined;
    expect(() => {
      (onStart as (info: { runId: string; id: string }) => void)({ runId: 'r1', id: 'child' });
      (onEnd as (info: { runId: string; id: string; stopReason?: string }) => void)({
        runId: 'r1',
        id: 'child',
        stopReason: 'error',
      });
    }).not.toThrow();
    // Both listeners are fire-and-forget; give their queued read-modify-writes
    // a turn before asserting that nothing was written.
    await new Promise((resolve) => setTimeout(resolve, 20));
    if (before === undefined) {
      expect(existsSync(file)).toBe(false);
      return;
    }
    expect(readFileSync(file, 'utf8')).toBe(before);
  });
});
