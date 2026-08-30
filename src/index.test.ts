import { describe, expect, it, vi, beforeEach } from 'vitest';

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

  it('registers an agent/session-start listener', () => {
    const events: string[] = [];
    const ctx: DshContext = {
      on: (event) => {
        events.push(event);
        return () => {};
      },
    };
    apply(ctx, { debug: false, autoApprove: false, autoInstallSkill: true });
    expect(events).toContain('agent/session-start');
  });

  it('syncs the bundled skill on load unless autoInstallSkill is false (#28)', () => {
    const ctx: DshContext = {
      on: () => () => {},
    };
    apply(ctx, { debug: false, autoApprove: false, autoInstallSkill: true });
    expect(installSkillMock).toHaveBeenCalledTimes(1);

    apply(ctx, { debug: false, autoApprove: false, autoInstallSkill: false });
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
    apply(ctx, { debug: false, autoApprove: false, autoInstallSkill: true });
    expect(events).toContain('approval/request');
    expect(events).toContain('tools/pre-execute');
    expect(events).toContain('tools/post-execute');
  });

  it('registers the mint overview on the agent ctx at session start', () => {
    const listeners: Record<string, EventListener> = {};
    const ctx: DshContext = {
      on: (event, listener) => {
        listeners[event] = listener;
        return () => {};
      },
    };
    apply(ctx, { debug: false, autoApprove: false, autoInstallSkill: true });

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
    const onSessionStart = listeners['agent/session-start'];
    expect(onSessionStart).toBeTypeOf('function');
    (onSessionStart as (payload: { agent?: { ctx: DshContext; session: { header: { cwd?: string } } } }) => void)({
      agent: { ctx: agentCtx, session: { header: { cwd: '/proj' } } },
    });

    expect(registered.map((r) => r.name)).toEqual(['mint:overview', 'mint:approval-guidance']);
  });

  it('skips registration without an agent payload', () => {
    const listeners: Record<string, EventListener> = {};
    const ctx: DshContext = {
      on: (event, listener) => {
        listeners[event] = listener;
        return () => {};
      },
    };
    apply(ctx, { debug: false, autoApprove: false, autoInstallSkill: true });
    const onSessionStart = listeners['agent/session-start'];
    expect(() =>
      (onSessionStart as (payload: { agent?: unknown }) => void)({}),
    ).not.toThrow();
    expect(runMintMock).not.toHaveBeenCalled();
  });
});
