import { describe, expect, it } from 'vitest';

import { buildMintArgs, compactIssues, executeQuery, installMintQuery } from './query.js';
import type { DshContext, ShellLike, ShellSpecLike, ToolDefinitionLike } from './types.js';

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

describe('buildMintArgs', () => {
  it('builds an issue query with filters', () => {
    const args = buildMintArgs({ scope: 'issue', status: 'open', kind: 'requirement', plan: 2, label: 'host', limit: 5 });
    expect(args).toEqual(['list', '--json', '--no-page', '--status', 'open', '--kind', 'requirement', '--plan', '2', '--label', 'host']);
  });

  it('builds plan and milestone queries', () => {
    expect(buildMintArgs({ scope: 'plan' })).toEqual(['plan', 'list', '--json']);
    expect(buildMintArgs({ scope: 'milestone' })).toEqual(['milestone', 'list', '--json']);
  });
});

describe('compactIssues', () => {
  it('keeps only model-relevant fields', () => {
    const items = [
      {
        id: 3,
        title: '上下文注入',
        status: 'dev',
        priority: 1,
        labels: ['host', 'agent'],
        plan_id: 1,
        created_at: '2026-08-29',
        dropped_reason: null,
      },
    ];
    const issues = compactIssues(items);
    expect(issues[0]).toEqual({
      id: 3,
      title: '上下文注入',
      status: 'dev',
      priority: 1,
      labels: ['host', 'agent'],
      plan_id: 1,
    });
  });
});

describe('executeQuery', () => {
  it('returns a compact issue summary', async () => {
    const { shell } = makeShell([
      {
        stdout: JSON.stringify({
          items: [
            { id: 3, title: '上下文注入', status: 'dev', priority: 1, labels: ['host'], plan_id: 1 },
            { id: 4, title: '事件提醒', status: 'done', priority: 1, labels: ['host'], plan_id: 1 },
          ],
        }),
      },
    ]);
    const result = await executeQuery(shell, { scope: 'issue', limit: 1 });
    expect(result.ok).toBe(true);
    expect(result.value).toEqual({ issues: [{ id: 3, title: '上下文注入', status: 'dev', priority: 1, labels: ['host'], plan_id: 1 }] });
  });

  it('returns plans and milestones', async () => {
    const { shell } = makeShell([{ stdout: JSON.stringify({ items: [{ id: 2, title: '宿主面', status: 'done' }] }) }]);
    const plans = await executeQuery(shell, { scope: 'plan' });
    expect(plans.value).toEqual({ plans: [{ id: 2, title: '宿主面', status: 'done' }] });
  });

  it('reports mint failure', async () => {
    const { shell } = makeShell([{ exitCode: 1, stderr: 'mint: db not found' }]);
    const result = await executeQuery(shell, { scope: 'issue' });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('mint: db not found');
  });
});

describe('installMintQuery', () => {
  it('registers the mint_query tool', () => {
    const definitions: ToolDefinitionLike[] = [];
    const { shell } = makeShell([]);
    const ctx: DshContext = {
      on: () => () => {},
      shell,
      tools: { register: (def) => { definitions.push(def); return () => {}; } },
    };
    installMintQuery(ctx);
    expect(definitions).toHaveLength(1);
    expect(definitions[0]?.name).toBe('mint_query');
    expect(definitions[0]?.parameters).toMatchObject({ required: ['scope'] });
  });

  it('returns undefined without tools or shell', () => {
    const ctx: DshContext = { on: () => () => {} };
    expect(installMintQuery(ctx)).toBeUndefined();
  });
});
