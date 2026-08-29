import { describe, expect, it, vi } from 'vitest';

import { registerMintContext, renderOverview } from './context.js';
import { runMint } from './mint.js';
import type { DshContext, ShellLike, ShellSpecLike } from './types.js';

function makeShell(
  script: Array<{ exitCode?: number; stdout?: string; stderr?: string }>,
): { shell: ShellLike; calls: string[] } {
  const calls: string[] = [];
  const runs = [...script];
  const shell: ShellLike = {
    resolve: (request) => {
      calls.push(request.command);
      return { command: request.command, workdir: '/proj', timeoutMs: request.timeoutMs ?? 30_000 };
    },
    run: (_spec: ShellSpecLike) => {
      const step = runs.shift() ?? { stdout: '{}' };
      return Promise.resolve({
        exitCode: step.exitCode ?? 0,
        stdout: { text: step.stdout ?? '' },
        stderr: { text: step.stderr ?? '' },
      });
    },
  };
  return { shell, calls };
}

function makeAgentCtx(shell?: ShellLike): {
  ctx: DshContext;
  registered: Array<{ name: string; order: number; text: string | (() => string) }>;
} {
  const registered: Array<{ name: string; order: number; text: string | (() => string) }> = [];
  const ctx: DshContext = {
    on: () => () => {},
    systemPrompt: {
      context: (spec) => {
        registered.push(spec);
        return () => {};
      },
    },
    ...(shell ? { shell } : {}),
  };
  return { ctx, registered };
}

describe('renderOverview', () => {
  it('renders active issues and running milestone', () => {
    const text = renderOverview({
      issues: [
        {
          id: 3,
          title: '实现上下文注入',
          kind: 'requirement',
          status: 'dev',
          priority: 1,
          labels: ['host'],
        },
      ],
      milestones: [{ title: '宿主面', version: '0.1.0', status: 'running' }],
    });
    expect(text).toContain('#3');
    expect(text).toContain('[requirement]');
    expect(text).toContain('(P1, dev)');
    expect(text).toContain('[host]');
    expect(text).toContain('running milestones: 0.1.0');
  });

  it('warns on 2+ running milestones', () => {
    const text = renderOverview({
      issues: [],
      milestones: [
        { title: 'a', version: '0.1.0', status: 'running' },
        { title: 'b', version: '0.2.0', status: 'running' },
      ],
    });
    expect(text).toContain('WARNING: multiple running milestones');
  });

  it('renders nothing when empty', () => {
    expect(renderOverview({ issues: [], milestones: [] })).toBe('');
  });
});

describe('registerMintContext', () => {
  it('registers the context and loads overview once (cached)', async () => {
    const { shell, calls } = makeShell([
      {
        stdout: JSON.stringify({
          items: [{ id: 3, title: '实现上下文注入', kind: 'requirement', status: 'dev', priority: 1, labels: ['host'] }],
        }),
      },
      { stdout: JSON.stringify({ items: [{ title: '宿主面', version: '0.1.0', status: 'running' }] }) },
    ]);
    const { ctx, registered } = makeAgentCtx(shell);
    registerMintContext(ctx);

    expect(registered.map((r) => r.name)).toEqual(['mint:overview']);
    const provider = registered[0]?.text as () => string;

    expect(provider()).toBe('');
    await vi.waitFor(() => expect(provider()).not.toBe(''));
    const text = provider();
    expect(text).toContain('#3');
    expect(text).toContain('running milestones: 0.1.0');

    // cache: provider returns without extra shell calls
    expect(provider()).toBe(text);
    expect(calls.length).toBe(2);
  });

  it('degrades to empty text on mint failure', async () => {
    const { shell } = makeShell([{ exitCode: 1, stderr: 'mint: db not found' }]);
    const { ctx, registered } = makeAgentCtx(shell);
    registerMintContext(ctx);
    const provider = registered[0]?.text as () => string;

    provider();
    await vi.waitFor(() => expect(provider()).toBe(''));
    expect(provider()).toBe('');
  });

  it('returns undefined without a systemPrompt service', () => {
    const ctx: DshContext = { on: () => () => {} };
    expect(registerMintContext(ctx)).toBeUndefined();
  });
});

describe('runMint', () => {
  it('resolves nonzero exit as an error, not a rejection', async () => {
    const { shell } = makeShell([{ exitCode: 2, stderr: 'boom' }]);
    const result = await runMint(shell, ['list', '--json']);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('boom');
  });

  it('returns stdout text on success', async () => {
    const { shell } = makeShell([{ stdout: '{"items":[]}' }]);
    const result = await runMint(shell, ['list', '--json']);
    expect(result.ok).toBe(true);
    expect(result.text).toBe('{"items":[]}');
  });
});
