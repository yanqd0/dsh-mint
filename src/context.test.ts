import { describe, expect, it, vi, beforeEach } from 'vitest';

import { fetchOverview, registerMintContext, renderOverview } from './context.js';
import { runMint } from './mint.js';
import type { DshContext } from './types.js';

vi.mock('./mint.js', () => ({ runMint: vi.fn() }));
const runMintMock = vi.mocked(runMint);

beforeEach(() => {
  runMintMock.mockReset();
});

function makeAgentCtx(): {
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
  };
  return { ctx, registered };
}

describe('fetchOverview', () => {
  it('queries issues and milestones in the project directory', async () => {
    runMintMock
      .mockResolvedValueOnce({
        ok: true,
        text: JSON.stringify({
          items: [{ id: 3, title: '实现上下文注入', kind: 'requirement', status: 'dev', priority: 1, labels: ['host'] }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        text: JSON.stringify({ items: [{ title: '宿主面', version: '0.1.0', status: 'running' }] }),
      });

    const overview = await fetchOverview('/proj');

    expect(overview.issues).toHaveLength(1);
    expect(overview.issues[0]?.title).toBe('实现上下文注入');
    expect(overview.milestones[0]?.version).toBe('0.1.0');
    expect(runMintMock).toHaveBeenNthCalledWith(1, '/proj', ['list', '--json', '--no-page']);
    expect(runMintMock).toHaveBeenNthCalledWith(2, '/proj', ['milestone', 'list', '--json']);
  });

  it('throws on mint failure', async () => {
    runMintMock.mockResolvedValueOnce({ ok: false, error: 'mint: db not found' });
    await expect(fetchOverview('/proj')).rejects.toThrow('mint: db not found');
  });
});

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
  it('registers the context and loads the overview once (cached)', async () => {
    runMintMock
      .mockResolvedValueOnce({
        ok: true,
        text: JSON.stringify({
          items: [{ id: 3, title: '实现上下文注入', kind: 'requirement', status: 'dev', priority: 1, labels: ['host'] }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        text: JSON.stringify({ items: [{ title: '宿主面', version: '0.1.0', status: 'running' }] }),
      });
    const { ctx, registered } = makeAgentCtx();
    registerMintContext(ctx, '/proj');

    expect(registered.map((r) => r.name)).toEqual(['mint:overview', 'mint:approval-guidance']);
    const provider = registered[0]?.text as () => string;

    expect(provider()).toBe('');
    await vi.waitFor(() => expect(provider()).not.toBe(''));
    const text = provider();
    expect(text).toContain('#3');
    expect(text).toContain('running milestones: 0.1.0');

    // cache: provider returns without extra mint calls
    expect(provider()).toBe(text);
    expect(runMintMock).toHaveBeenCalledTimes(2);
  });

  it('degrades to empty text on mint failure', async () => {
    runMintMock.mockResolvedValueOnce({ ok: false, error: 'mint: db not found' });
    const { ctx, registered } = makeAgentCtx();
    registerMintContext(ctx, '/proj');
    const provider = registered[0]?.text as () => string;

    provider();
    await vi.waitFor(() => expect(provider()).toBe(''));
    expect(provider()).toBe('');
  });

  it('returns undefined without a systemPrompt service', () => {
    const ctx: DshContext = { on: () => () => {} };
    expect(registerMintContext(ctx, '/proj')).toBeUndefined();
  });
});
