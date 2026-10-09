import { existsSync, readFileSync } from 'node:fs';

import { describe, expect, it, vi, beforeEach } from 'vitest';

import { DAG_DIR } from '../../src/dag/dag-store.js';
import { apply, Config, inject, name } from '../../src/index.js';
import { installSkill } from '../../src/skill/install-skill.js';
import { runMint } from '../../src/mint/mint.js';
import type { DshContext, EventListener } from '../../src/shared/types.js';

vi.mock('../../src/mint/mint.js', () => ({ runMint: vi.fn() }));
vi.mock('../../src/skill/install-skill.js', () => ({ installSkill: vi.fn(() => ({ ok: true })) }));
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

  it('parses a missing mount-line config into the defaults', () => {
    const defaults = {
      debug: false,
      autoApprove: false,
      autoInstallSkill: true,
      openDagTab: true,
    };

    // Same validation path the host takes: cordis `resolveConfig` passes the raw
    // mount-line `config` (absent => `undefined`) straight to the schema's
    // `~standard` validator, without normalizing it first. That call is typed
    // `Result | Promise<Result>` with mutually exclusive `value`/`issues` (an
    // async schema is legal too), so narrow to the synchronous arm here.
    const parse = (input: unknown): { value?: Config; issues?: ReadonlyArray<unknown> } => {
      const result = Config['~standard'].validate(input);
      expect(result).not.toBeInstanceOf(Promise);
      return result as { value?: Config; issues?: ReadonlyArray<unknown> };
    };

    const missing = parse(undefined);
    expect(missing.issues).toBeUndefined();
    expect(missing.value).toEqual(defaults);

    // An explicit empty object is the documented alternative and must match.
    const empty = parse({});
    expect(empty.issues).toBeUndefined();
    expect(empty.value).toEqual(defaults);
  });

  it('registers the agent lifecycle listeners', () => {
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
    // a non-tool plan-mode exit is read off the session log.
    expect(events).toContain('session/event');
    // the two subagent events pair a delegated run with its DAG node.
    expect(events).toContain('subagent/start');
    expect(events).toContain('subagent/end');
  });

  // 开关门禁：`autoInstallSkill` 只影响加载时那次 skill 同步，关掉就不再调用。
  // 同一个 ctx 连调两次 `apply`（先 true 后 false），断言 mock 的调用次数停在 1。
  it('syncs the bundled skill on load unless autoInstallSkill is false', () => {
    const ctx: DshContext = {
      on: () => () => {},
    };
    apply(ctx, { debug: false, autoApprove: false, autoInstallSkill: true, openDagTab: true });
    expect(installSkillMock).toHaveBeenCalledTimes(1);

    apply(ctx, { debug: false, autoApprove: false, autoInstallSkill: false, openDagTab: true });
    expect(installSkillMock).toHaveBeenCalledTimes(1);
  });

  // 审批门禁的三个缝必须挂上，否则提权审批与工具前后钩子整条链断开。
  // 记账用的 ctx 收下所有注册事件名，断言 `approval/request` 与两个工具钩子都在。
  it('registers the approval gate seams (B-v2)', () => {
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

  it('registers the mint overview on the agent ctx at agent creation', () => {
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

  // 防御路径：宿主没给 agent 载荷时跳过登记，既不抛错也不去跑 mint。
  // 直接调用 `agent/created` 的监听器并传空载荷，断言不抛且 `runMint` 未被调用。
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

  // 工具面契约：根 ctx 上恰好是三个工具（`worktree` 已从 `mint_plan_dag` 拆出独立）。
  // 记账用的 `tools.register` 收下名字，整体比对工具名序列。
  it('registers the plan DAG tool and the standalone worktree tool next to mint', () => {
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
    // worktree 已从 mint_plan_dag 拆出，成为第三个根 ctx 工具。
    expect(names).toEqual(['mint', 'mint_plan_dag', 'worktree']);
  });

  it('pairs a subagent run with a node of its parent DAG', async () => {
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
