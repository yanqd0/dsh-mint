import { describe, expect, it, vi, beforeEach } from 'vitest';

import { buildMintArgs, compactIssues, executeQuery, installMintQuery } from './query.js';
import { runMint } from './mint.js';
import type { DshContext, ToolDefinitionLike, ToolExecutionLike } from './types.js';

vi.mock('./mint.js', () => ({ runMint: vi.fn() }));
const runMintMock = vi.mocked(runMint);

beforeEach(() => {
  runMintMock.mockReset();
});

function makeExec(cwd?: string): ToolExecutionLike {
  return {
    name: 'mint_query',
    arguments: {},
    ...(cwd ? { agent: { session: { header: { cwd } } } } : {}),
  };
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
  it('returns a compact issue summary in the project directory', async () => {
    runMintMock.mockResolvedValueOnce({
      ok: true,
      text: JSON.stringify({
        items: [
          { id: 3, title: '上下文注入', status: 'dev', priority: 1, labels: ['host'], plan_id: 1 },
          { id: 4, title: '事件提醒', status: 'done', priority: 1, labels: ['host'], plan_id: 1 },
        ],
      }),
    });
    const result = await executeQuery('/proj', { scope: 'issue', limit: 1 });
    expect(result.ok).toBe(true);
    expect(result.value).toEqual({ issues: [{ id: 3, title: '上下文注入', status: 'dev', priority: 1, labels: ['host'], plan_id: 1 }] });
    expect(runMintMock).toHaveBeenCalledWith('/proj', ['list', '--json', '--no-page']);
  });

  it('returns plans and milestones', async () => {
    runMintMock.mockResolvedValueOnce({ ok: true, text: JSON.stringify({ items: [{ id: 2, title: '宿主面', status: 'done' }] }) });
    const plans = await executeQuery('/proj', { scope: 'plan' });
    expect(plans.value).toEqual({ plans: [{ id: 2, title: '宿主面', status: 'done' }] });
  });

  it('reports mint failure', async () => {
    runMintMock.mockResolvedValueOnce({ ok: false, error: 'mint: db not found' });
    const result = await executeQuery('/proj', { scope: 'issue' });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('mint: db not found');
  });
});

describe('installMintQuery', () => {
  it('registers the mint_query tool', () => {
    const definitions: ToolDefinitionLike[] = [];
    const ctx: DshContext = {
      on: () => () => {},
      tools: { register: (def) => { definitions.push(def); return () => {}; } },
    };
    installMintQuery(ctx);
    expect(definitions).toHaveLength(1);
    expect(definitions[0]?.name).toBe('mint_query');
    expect(definitions[0]?.parameters).toMatchObject({ required: ['scope'] });
  });

  it('executes with the session project directory', async () => {
    runMintMock.mockResolvedValueOnce({ ok: true, text: JSON.stringify({ items: [{ id: 1, title: 'a', status: 'open', priority: 1, labels: [], plan_id: null }] }) });
    const definitions: ToolDefinitionLike[] = [];
    const ctx: DshContext = {
      on: () => () => {},
      tools: { register: (def) => { definitions.push(def); return () => {}; } },
    };
    installMintQuery(ctx);
    const execute = definitions[0]?.execute;
    expect(execute).toBeTypeOf('function');

    const value = await execute?.({ scope: 'issue' }, makeExec('/proj'));
    expect(value).toEqual({ issues: [{ id: 1, title: 'a', status: 'open', priority: 1, labels: [], plan_id: null }] });
    expect(runMintMock).toHaveBeenCalledWith('/proj', ['list', '--json', '--no-page']);
  });

  it('throws on a failed query', async () => {
    runMintMock.mockResolvedValueOnce({ ok: false, error: 'mint: db not found' });
    const definitions: ToolDefinitionLike[] = [];
    const ctx: DshContext = {
      on: () => () => {},
      tools: { register: (def) => { definitions.push(def); return () => {}; } },
    };
    installMintQuery(ctx);
    await expect(definitions[0]?.execute?.({ scope: 'issue' }, makeExec('/proj'))).rejects.toThrow('mint: db not found');
  });

  it('returns undefined without tools', () => {
    const ctx: DshContext = { on: () => () => {} };
    expect(installMintQuery(ctx)).toBeUndefined();
  });
});
