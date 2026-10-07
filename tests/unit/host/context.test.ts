import { describe, expect, it, vi, beforeEach } from 'vitest';

import {
  MINT_TOOL_GUIDANCE,
  RECORD_GAP_LINE,
  fetchOverview,
  installOverviewChannel,
  latestVersion,
  registerMintContext,
  renderOverview,
  supportsDoctor,
} from '../../../src/host/context.js';
import { MINT_ENTRY_WARNING, resolveMintEntry, runMint } from '../../../src/mint/mint.js';
import { ownProjectOf, resetOwnProjectCache } from '../../../src/mint/own-project.js';
import { notePlanModeExit, recordMintWrite, resetSessionLedger } from '../../../src/host/session-ledger.js';
import type { DshContext } from '../../../src/shared/types.js';

vi.mock('../../../src/mint/mint.js', () => ({
  runMint: vi.fn(),
  resolveMintEntry: vi.fn(() => '/pkg/node_modules/mint-faa/run-mint.js'),
  describeMintEntry: vi.fn(() => 'mint-faa@0.8.0'),
  MINT_ENTRY_WARNING:
    'mint 入口解析失败（mint-faa 不可见）→ 挂载行 mintEntry 或 MINT_ENTRY，改后重启 harness',
  parseMintVersion: (text: string | undefined) => /\bmint\s+v?(\d[^\s]*)/.exec(text ?? '')?.[1],
}));
const runMintMock = vi.mocked(runMint);

/**
 * A real `mint doctor --json` payload: captured from the dsh-mint ledger
 * with `--days 1`, where one stale plan fired. Only `warnings`/`counts` are read
 * by the overview; the rest is what the CLI actually sends.
 */
const DOCTOR_JSON = JSON.stringify({
  check: 'doctor',
  counts: {
    'idle-milestone': 0,
    'multiple-running': 0,
    'overlap-plan': 0,
    'stale-plan': 1,
    'stalled-dev': 0,
  },
  days: 1,
  items: [{ age_days: 2, check: 'stale-plan', detail: 'title=…; active=2; 2d' }],
  strict: false,
  summary: {
    checks: 5,
    days: 1,
    line: '# doctor: checks=5 warnings=1 strict=0 days=1 counts=multiple-running:0,stale-plan:1,overlap-plan:0,idle-milestone:0,stalled-dev:0',
    strict: false,
    warnings: 1,
  },
  total: 1,
  warnings: 1,
});

beforeEach(() => {
  runMintMock.mockReset();
  resetOwnProjectCache();
  resetSessionLedger();
});

function makeAgentCtx(): {
  ctx: DshContext;
  registered: Array<{ name: string; order: number; text: string | (() => string) }>;
  sections: Array<{ name: string; order: number; text: string }>;
} {
  const registered: Array<{ name: string; order: number; text: string | (() => string) }> = [];
  const sections: Array<{ name: string; order: number; text: string }> = [];
  const ctx: DshContext = {
    on: () => () => {},
    systemPrompt: {
      context: (spec) => {
        registered.push(spec);
        return () => {};
      },
      section: (spec) => {
        sections.push(spec);
        return () => {};
      },
    },
  };
  return { ctx, registered, sections };
}

describe('fetchOverview', () => {
  it('queries issues and milestones in the project directory', async () => {
    runMintMock
      .mockResolvedValueOnce({
        ok: true,
        text: JSON.stringify({
          items: [
            {
              id: 3,
              title: '实现上下文注入',
              kind: 'requirement',
              status: 'dev',
              priority: 1,
              labels: ['host'],
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        text: JSON.stringify({
          items: [{ id: 1, title: '宿主面', version: '0.1.0', status: 'running' }],
        }),
      })
      .mockResolvedValueOnce({ ok: true, text: 'mint 0.8.0-alpha.1\n' });

    const overview = await fetchOverview('/proj');

    expect(overview.issues).toHaveLength(1);
    expect(overview.issues[0]?.title).toBe('实现上下文注入');
    expect(overview.milestones[0]?.version).toBe('0.1.0');
    expect(overview.cliVersion).toBe('0.8.0-alpha.1');
    expect(overview.cliEntry).toBe('mint-faa@0.8.0');
    expect(runMintMock).toHaveBeenNthCalledWith(1, '/proj', ['list', '--json', '--no-page']);
    expect(runMintMock).toHaveBeenNthCalledWith(2, '/proj', ['milestone', 'list', '--json']);
    expect(runMintMock).toHaveBeenNthCalledWith(3, '/proj', ['-V']);
  });

  it('reads the resolved project name off the issue rows', async () => {
    runMintMock
      .mockResolvedValueOnce({
        ok: true,
        text: JSON.stringify({
          items: [
            {
              id: 1,
              title: '实现上下文注入',
              kind: 'requirement',
              status: 'dev',
              priority: 1,
              labels: [],
              project: 'dsh-mint',
            },
          ],
        }),
      })
      .mockResolvedValueOnce({ ok: true, text: JSON.stringify({ items: [] }) })
      .mockResolvedValueOnce({ ok: false, exitCode: 2, error: 'nope' });

    expect((await fetchOverview('/proj')).project).toBe('dsh-mint');
  });

  it('leaves the project unknown when no row names one', async () => {
    runMintMock
      .mockResolvedValueOnce({
        ok: true,
        text: JSON.stringify({
          items: [{ id: 1, title: 'a', kind: 'task', status: 'open', priority: 2, labels: [] }],
        }),
      })
      .mockResolvedValueOnce({ ok: true, text: JSON.stringify({ items: [] }) })
      .mockResolvedValueOnce({ ok: false, exitCode: 2, error: 'nope' });

    expect((await fetchOverview('/proj')).project).toBeUndefined();
  });

  it('flags an unrecognized list shape instead of reporting an empty backlog', async () => {
    runMintMock
      .mockResolvedValueOnce({ ok: true, text: JSON.stringify({ data: [] }) })
      .mockResolvedValueOnce({ ok: true, text: JSON.stringify({ items: [] }) })
      .mockResolvedValueOnce({ ok: false, exitCode: 2, error: 'unexpected argument' });

    const overview = await fetchOverview('/proj');
    expect(overview.issues).toEqual([]);
    expect(overview.warnings?.[0]).toContain('list --json');
    expect(overview.warnings?.[0]).toContain('no "items" array');
  });

  it('drops items missing required fields and counts them', async () => {
    runMintMock
      .mockResolvedValueOnce({
        ok: true,
        text: JSON.stringify({
          items: [
            { id: 1, title: 'ok', kind: 'task', status: 'open', priority: 2, labels: [] },
            // `priority` renamed away — must not render as a plausible issue
            { id: 2, title: 'skewed', kind: 'task', status: 'open', labels: [] },
          ],
        }),
      })
      .mockResolvedValueOnce({ ok: true, text: JSON.stringify({ items: [] }) })
      .mockResolvedValueOnce({ ok: false, exitCode: 2, error: 'nope' });

    const overview = await fetchOverview('/proj');
    expect(overview.issues).toHaveLength(1);
    expect(overview.warnings?.[0]).toContain('1/2 items missing required fields');
  });

  it('keeps a valid empty list warning-free', async () => {
    runMintMock
      .mockResolvedValueOnce({ ok: true, text: JSON.stringify({ items: [] }) })
      .mockResolvedValueOnce({ ok: true, text: JSON.stringify({ items: [] }) })
      .mockResolvedValueOnce({ ok: false, exitCode: 2, error: 'nope' });

    const overview = await fetchOverview('/proj');
    expect(overview.warnings).toBeUndefined();
  });

  it('keeps a milestone whose version is null, without a shape warning', async () => {
    runMintMock
      .mockResolvedValueOnce({ ok: true, text: JSON.stringify({ items: [] }) })
      .mockResolvedValueOnce({
        ok: true,
        text: JSON.stringify({
          items: [{ id: 4, title: '无版本', version: null, status: 'running', issue_count: 0 }],
        }),
      })
      .mockResolvedValueOnce({ ok: false, exitCode: 2, error: 'nope' });

    const overview = await fetchOverview('/proj');
    expect(overview.milestones).toEqual([
      { id: 4, title: '无版本', version: null, status: 'running', issue_count: 0 },
    ]);
    expect(overview.warnings).toBeUndefined();
  });

  it('keeps the overview when the -V probe fails', async () => {
    runMintMock
      .mockResolvedValueOnce({ ok: true, text: JSON.stringify({ items: [] }) })
      .mockResolvedValueOnce({ ok: true, text: JSON.stringify({ items: [] }) })
      .mockResolvedValueOnce({ ok: false, exitCode: 2, error: 'unexpected argument' });

    const overview = await fetchOverview('/proj');
    expect(overview.cliVersion).toBeUndefined();
    expect(overview.issues).toEqual([]);
  });

  it('throws on mint failure', async () => {
    runMintMock.mockResolvedValueOnce({ ok: false, error: 'mint: db not found' });
    await expect(fetchOverview('/proj')).rejects.toThrow('mint: db not found');
  });

  it('asks doctor for a CLI that has it, and keeps the verdict', async () => {
    runMintMock
      .mockResolvedValueOnce({ ok: true, text: JSON.stringify({ items: [] }) })
      .mockResolvedValueOnce({ ok: true, text: JSON.stringify({ items: [] }) })
      .mockResolvedValueOnce({ ok: true, text: 'mint 0.9.0-alpha.1\n' })
      .mockResolvedValueOnce({ ok: true, text: DOCTOR_JSON });

    const overview = await fetchOverview('/proj');

    expect(overview.doctor).toEqual({
      warnings: 1,
      counts: {
        'idle-milestone': 0,
        'multiple-running': 0,
        'overlap-plan': 0,
        'stale-plan': 1,
        'stalled-dev': 0,
      },
    });
    expect(overview.warnings).toBeUndefined();
    // the doctor read is sequential: it is gated on the version `-V` answered
    expect(runMintMock).toHaveBeenNthCalledWith(4, '/proj', ['doctor', '--json']);
  });

  it('does not spend a spawn on doctor for an older CLI', async () => {
    runMintMock
      .mockResolvedValueOnce({ ok: true, text: JSON.stringify({ items: [] }) })
      .mockResolvedValueOnce({ ok: true, text: JSON.stringify({ items: [] }) })
      .mockResolvedValueOnce({ ok: true, text: 'mint 0.8.1\n' });

    const overview = await fetchOverview('/proj');

    expect(overview.doctor).toBeUndefined();
    expect(runMintMock).toHaveBeenCalledTimes(3);
  });

  it('ignores a doctor run that did not answer', async () => {
    runMintMock
      .mockResolvedValueOnce({ ok: true, text: JSON.stringify({ items: [] }) })
      .mockResolvedValueOnce({ ok: true, text: JSON.stringify({ items: [] }) })
      .mockResolvedValueOnce({ ok: true, text: 'mint 0.9.0-alpha.1\n' })
      .mockResolvedValueOnce({
        ok: false,
        exitCode: 2,
        error: "unrecognized subcommand 'doctor'",
      });

    const overview = await fetchOverview('/proj');

    expect(overview.doctor).toBeUndefined();
    expect(overview.warnings).toBeUndefined();
  });

  it('reports a doctor shape skew instead of hiding it', async () => {
    runMintMock
      .mockResolvedValueOnce({ ok: true, text: JSON.stringify({ items: [] }) })
      .mockResolvedValueOnce({ ok: true, text: JSON.stringify({ items: [] }) })
      .mockResolvedValueOnce({ ok: true, text: 'mint 0.9.0-alpha.1\n' })
      .mockResolvedValueOnce({ ok: true, text: JSON.stringify({ data: [] }) });

    const overview = await fetchOverview('/proj');

    expect(overview.doctor).toBeUndefined();
    expect(overview.warnings?.[0]).toContain('doctor --json');
    expect(overview.warnings?.[0]).toContain('missing required fields');
  });

  it('skips doctor when the version probe failed', async () => {
    runMintMock
      .mockResolvedValueOnce({ ok: true, text: JSON.stringify({ items: [] }) })
      .mockResolvedValueOnce({ ok: true, text: JSON.stringify({ items: [] }) })
      .mockResolvedValueOnce({ ok: false, exitCode: 2, error: 'unexpected argument' });

    const overview = await fetchOverview('/proj');

    expect(overview.doctor).toBeUndefined();
    expect(runMintMock).toHaveBeenCalledTimes(3);
  });
});

describe('supportsDoctor', () => {
  it('accepts the 0.9 line and later, prerelease suffix included', () => {
    expect(supportsDoctor('0.9.0')).toBe(true);
    expect(supportsDoctor('0.9.0-alpha.1')).toBe(true);
    expect(supportsDoctor('0.10.1')).toBe(true);
    expect(supportsDoctor('1.0.0')).toBe(true);
  });

  it('rejects older or unparsable versions', () => {
    expect(supportsDoctor('0.8.1')).toBe(false);
    expect(supportsDoctor('0.8.0-alpha.1')).toBe(false);
    expect(supportsDoctor('')).toBe(false);
    expect(supportsDoctor('unknown')).toBe(false);
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
      milestones: [{ id: 1, title: '宿主面', version: '0.1.0', status: 'running' }],
    });
    expect(text).toContain('#3');
    expect(text).toContain('[requirement]');
    expect(text).toContain('(P1, dev)');
    // labels are deliberately not injected — they cost the most per line
    // and are one `mint list`/`show` call away
    expect(text).not.toContain('[host]');
    expect(text).toContain('milestone 0.1.0 (id 1) running');
    expect(text).toContain('mint({args:["milestone","attach","1","<id>"]})');
    expect(text).toContain('plan create --milestone 1');
  });

  it('caps the issue list at five and states the real total', () => {
    const issues = Array.from({ length: 9 }, (_, index) => ({
      id: index + 1,
      title: `issue ${index + 1}`,
      kind: 'requirement',
      status: 'open',
      priority: 1,
      labels: [],
    }));
    const text = renderOverview({ issues, milestones: [] });
    expect(text).toContain('[Mint] issues (top 5 of 9):');
    expect(text.split('\n').filter((line) => line.startsWith('- #'))).toHaveLength(5);
  });

  it('suggests a next version when nothing is running', () => {
    const text = renderOverview({
      issues: [],
      milestones: [
        { id: 1, title: '宿主面', version: '0.1.0', status: 'done' },
        { id: 2, title: '会话 tab', version: '0.2.0', status: 'open' },
      ],
    });
    expect(text).toContain('no running milestone (latest 0.2.0)');
    expect(text).toContain('infer the next version by semver');
    expect(text).toContain('ASK the user');
    expect(text).toContain('do not set it yourself');
  });

  it('ranks a release above its prerelease and ignores non-numeric parts', () => {
    const milestones = [
      { id: 1, title: 'a', version: '0.1.0-alpha.3', status: 'done' },
      { id: 2, title: 'b', version: '0.1.0', status: 'done' },
      { id: 3, title: 'c', version: '0.0.9', status: 'done' },
    ];
    expect(latestVersion(milestones)).toBe('0.1.0');
  });

  it('keeps a version-less milestone and skips it when ranking', () => {
    // mint's `version` column is nullable, so `null` is a declared answer: the
    // milestone must stay in the overview, and the semver hint must fall back to
    // the versions that do exist.
    const milestones = [
      { id: 1, title: 'a', version: null, status: 'running' },
      { id: 2, title: 'b', version: '0.3.0', status: 'open' },
    ];
    expect(latestVersion(milestones)).toBe('0.3.0');

    const text = renderOverview({ issues: [], milestones });
    // One running milestone: it is named even without a version (by title).
    expect(text).toContain('[Mint] milestone a (id 1) running');
    expect(text).toContain('mint({args:["milestone","attach","1","<id>"]})');
  });

  it('drops the latest-version parenthetical when no milestone has a version', () => {
    const text = renderOverview({
      issues: [],
      milestones: [{ id: 1, title: 'a', version: null, status: 'open' }],
    });
    expect(text).toContain('no running milestone —');
    expect(text).not.toContain('(latest )');
  });

  it('warns on 2+ running milestones with the CLI guard, not a manual reopen', () => {
    const text = renderOverview({
      issues: [],
      milestones: [
        { id: 1, title: 'a', version: '0.1.0', status: 'running' },
        { id: 2, title: 'b', version: '0.2.0', status: 'running' },
      ],
    });
    expect(text).toContain('WARNING: 2 running milestones');
    expect(text).toContain('ask the user');
    expect(text).toContain('--force');
    // the old advice (reopen the later one by hand) is what the CLI now
    // rejects / makes moot, so it must not come back
    expect(text).not.toContain('keep exactly one');
    expect(text).not.toContain('"--status","open"');
  });

  it('renders nothing when empty', () => {
    expect(renderOverview({ issues: [], milestones: [] })).toBe('');
  });

  it('renders one doctor line when the health check has warnings', () => {
    const text = renderOverview({
      issues: [],
      milestones: [],
      doctor: { warnings: 2, counts: { 'stalled-dev': 2, 'stale-plan': 1, 'idle-milestone': 0 } },
    });
    // mint's own check order, not the JSON map's alphabetical order
    expect(text).toContain('[Mint] doctor: 2 health warnings (stale-plan:1, stalled-dev:2)');
    expect(text).toContain('mint({args:["doctor","--json"]})');
  });

  it('keeps an unknown doctor check visible, after the known ones', () => {
    const text = renderOverview({
      issues: [],
      milestones: [],
      doctor: { warnings: 1, counts: { 'new-check': 1 } },
    });
    expect(text).toContain('[Mint] doctor: 1 health warning (new-check:1)');
  });

  it('adds no doctor line for a clean ledger', () => {
    const text = renderOverview({
      issues: [],
      milestones: [],
      project: 'dsh-mint',
      doctor: { warnings: 0, counts: { 'stale-plan': 0 } },
    });
    expect(text).toBe('[Mint] dsh-mint');
  });

  it('renders shape-skew warnings', () => {
    const text = renderOverview({
      issues: [],
      milestones: [],
      cliVersion: '0.8.0',
      warnings: ['list --json: no "items" array — overview unavailable'],
    });
    expect(text.split('\n')).toEqual([
      '[Mint] mint 0.8.0',
      '[Mint] WARNING: list --json: no "items" array — overview unavailable',
    ]);
  });

  it('renders the running mint version and entry label first', () => {
    const text = renderOverview({
      issues: [],
      milestones: [],
      cliVersion: '0.8.0-alpha.1',
      cliEntry: '…/target/debug/mint',
    });
    expect(text.split('\n')[0]).toBe('[Mint] mint 0.8.0-alpha.1 via …/target/debug/mint');
  });

  it('omits the entry label when the probe could not name it', () => {
    const text = renderOverview({ issues: [], milestones: [], cliVersion: '0.8.0-alpha.1' });
    expect(text).toBe('[Mint] mint 0.8.0-alpha.1');
  });

  it('names the resolved project ahead of the version', () => {
    const text = renderOverview({
      issues: [],
      milestones: [],
      project: 'dsh-mint',
      cliVersion: '0.8.0-alpha.1',
    });
    expect(text.split('\n')[0]).toBe('[Mint] dsh-mint · mint 0.8.0-alpha.1');
  });

  it('still names the project when the -V probe failed', () => {
    const text = renderOverview({ issues: [], milestones: [], project: 'dsh-mint' });
    expect(text).toBe('[Mint] dsh-mint');
  });
});

describe('registerMintContext', () => {
  it('registers the context and loads the overview once (cached)', async () => {
    runMintMock
      .mockResolvedValueOnce({
        ok: true,
        text: JSON.stringify({
          items: [
            {
              id: 3,
              title: '实现上下文注入',
              kind: 'requirement',
              status: 'dev',
              priority: 1,
              labels: ['host'],
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        text: JSON.stringify({
          items: [{ id: 1, title: '宿主面', version: '0.1.0', status: 'running' }],
        }),
      })
      .mockResolvedValueOnce({ ok: true, text: 'mint 0.8.0-alpha.1\n' });
    const { ctx, registered, sections } = makeAgentCtx();
    registerMintContext(ctx, '/proj');

    expect(registered.map((r) => r.name)).toEqual(['mint:overview']);
    expect(sections.map((s) => s.name)).toEqual(['mint:tool-guidance']);
    const provider = registered[0]?.text as () => string;

    expect(provider()).toBe('');
    await vi.waitFor(() => expect(provider()).not.toBe(''));
    const text = provider();
    expect(text).toContain('#3');
    expect(text).toContain('milestone 0.1.0 (id 1) running');

    // cache: provider returns without extra mint calls
    expect(provider()).toBe(text);
    expect(runMintMock).toHaveBeenCalledTimes(3);
  });

  // a non-tool exit from plan mode has no tool result to enrich, so the
  // signal rides on the overview — once per session, and only while the session
  // still has nothing recorded.
  it('adds the record-gap line once after a plan-mode exit without records', async () => {
    runMintMock
      .mockResolvedValueOnce({
        ok: true,
        text: JSON.stringify({
          items: [
            { id: 3, title: '注入', kind: 'requirement', status: 'dev', priority: 1, labels: [] },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        text: JSON.stringify({
          items: [{ id: 1, title: '宿主面', version: '0.1.0', status: 'running' }],
        }),
      })
      .mockResolvedValueOnce({ ok: true, text: 'mint 0.8.0-alpha.1\n' });
    const { ctx, registered } = makeAgentCtx();
    registerMintContext(ctx, '/proj', undefined, 'sess-1');
    const provider = registered[0]?.text as () => string;
    await vi.waitFor(() => expect(provider()).not.toBe(''));

    const overview = provider();
    expect(overview).not.toContain(RECORD_GAP_LINE);

    notePlanModeExit('sess-1');
    expect(provider()).toBe(`${overview}\n${RECORD_GAP_LINE}`);
    // one shot: the same session is not told again on the next request
    expect(provider()).toBe(overview);
  });

  it('keeps the record-gap line out when the session recorded work', async () => {
    runMintMock
      .mockResolvedValueOnce({ ok: true, text: JSON.stringify({ items: [] }) })
      .mockResolvedValueOnce({ ok: true, text: JSON.stringify({ items: [] }) })
      .mockResolvedValueOnce({ ok: true, text: 'mint 0.8.0-alpha.1\n' });
    const { ctx, registered } = makeAgentCtx();
    registerMintContext(ctx, '/proj', undefined, 'sess-2');
    const provider = registered[0]?.text as () => string;
    await vi.waitFor(() => expect(provider()).not.toBe(''));

    notePlanModeExit('sess-2');
    recordMintWrite('sess-2');

    expect(provider()).not.toContain(RECORD_GAP_LINE);
  });

  it('keeps the record-gap line out for a session it cannot name', async () => {
    runMintMock
      .mockResolvedValueOnce({ ok: true, text: JSON.stringify({ items: [] }) })
      .mockResolvedValueOnce({ ok: true, text: JSON.stringify({ items: [] }) })
      .mockResolvedValueOnce({ ok: true, text: 'mint 0.8.0-alpha.1\n' });
    const { ctx, registered } = makeAgentCtx();
    registerMintContext(ctx, '/proj');
    const provider = registered[0]?.text as () => string;
    await vi.waitFor(() => expect(provider()).not.toBe(''));

    notePlanModeExit('sess-3');

    expect(provider()).not.toContain(RECORD_GAP_LINE);
  });

  it('remembers the project the overview resolved, keyed by directory', async () => {
    runMintMock
      .mockResolvedValueOnce({
        ok: true,
        text: JSON.stringify({
          items: [
            {
              id: 3,
              title: '实现上下文注入',
              kind: 'requirement',
              status: 'dev',
              priority: 1,
              labels: [],
              project: 'dsh-mint',
            },
          ],
        }),
      })
      .mockResolvedValueOnce({ ok: true, text: JSON.stringify({ items: [] }) })
      .mockResolvedValueOnce({ ok: true, text: 'mint 0.8.0-alpha.1\n' });
    const { ctx, registered } = makeAgentCtx();
    registerMintContext(ctx, '/proj');
    const provider = registered[0]?.text as () => string;

    provider();
    await vi.waitFor(() => expect(provider()).not.toBe(''));

    expect(ownProjectOf('/proj', undefined)).toBe('dsh-mint');
    expect(ownProjectOf('/elsewhere', undefined)).toBeUndefined();
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

  it('surfaces an unresolvable entry instead of reading as an empty project', async () => {
    vi.mocked(resolveMintEntry).mockImplementationOnce(() => {
      throw new Error('mint-faa missing');
    });
    const { ctx, registered } = makeAgentCtx();
    registerMintContext(ctx, '/proj');
    const provider = registered[0]?.text as () => string;

    provider();
    await vi.waitFor(() => expect(provider()).toContain('[Mint] WARNING'));
    expect(provider()).toBe(`[Mint] WARNING: ${MINT_ENTRY_WARNING}`);
    expect(runMintMock).not.toHaveBeenCalled();
  });

  it('returns undefined without a systemPrompt service', () => {
    const ctx: DshContext = { on: () => () => {} };
    expect(registerMintContext(ctx, '/proj')).toBeUndefined();
  });

  it('falls back to a context provider when the host has no section()', () => {
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
    registerMintContext(ctx, '/proj');

    expect(registered.map((r) => r.name)).toEqual(['mint:overview', 'mint:tool-guidance']);
    expect(registered[1]?.text).toBe(MINT_TOOL_GUIDANCE);
  });

  it('registers the tool-first guidance with no bash-escalation prompt', () => {
    const { ctx, sections } = makeAgentCtx();
    registerMintContext(ctx, '/proj');

    const guidance = sections[0];
    expect(guidance?.order).toBe(110);
    // the tool-first policy lives here and only here
    expect(guidance?.text).toContain('一律走宿主 mint 工具');
    expect(guidance?.text).toContain('不经 bash');
    expect(guidance?.text).not.toContain('danger-full-access');
  });

  it('disposes both registrations', () => {
    const disposed: string[] = [];
    const ctx: DshContext = {
      on: () => () => {},
      systemPrompt: {
        context: () => () => disposed.push('context'),
        section: () => () => disposed.push('section'),
      },
    };
    const dispose = registerMintContext(ctx, '/proj');
    dispose?.();
    expect(disposed).toEqual(['context', 'section']);
  });
});

describe('installOverviewChannel', () => {
  type Payload = { agent?: unknown };

  function makeRootCtx(): {
    ctx: DshContext;
    listeners: Record<string, (payload: Payload) => void>;
  } {
    const listeners: Record<string, (payload: Payload) => void> = {};
    const ctx: DshContext = {
      on: (event, listener) => {
        listeners[event] = listener as (payload: Payload) => void;
        return () => {};
      },
    };
    return { ctx, listeners };
  }

  function makeAgent(
    header: { cwd?: string; delegationDepth?: number } = { cwd: '/proj' },
    sessionId?: string
  ): { agent: unknown; registered: Array<{ name: string }>; sections: Array<{ name: string }> } {
    const { ctx, registered, sections } = makeAgentCtx();
    return {
      agent: { ctx, session: { ...(sessionId === undefined ? {} : { id: sessionId }), header } },
      registered,
      sections,
    };
  }

  it('wires the host event and the legacy name', () => {
    const { ctx, listeners } = makeRootCtx();
    installOverviewChannel(ctx);
    expect(listeners['agent/created']).toBeTypeOf('function');
    expect(listeners['agent/session-start']).toBeTypeOf('function');
  });

  it('registers the overview and the guidance when an agent is created', () => {
    const { ctx, listeners } = makeRootCtx();
    installOverviewChannel(ctx);
    const { agent, registered, sections } = makeAgent({ cwd: '/proj' }, 'sess-1');

    listeners['agent/created']?.({ agent });

    expect(registered.map((r) => r.name)).toEqual(['mint:overview']);
    expect(sections.map((s) => s.name)).toEqual(['mint:tool-guidance']);
  });

  it('registers once per session when both events fire', () => {
    const { ctx, listeners } = makeRootCtx();
    installOverviewChannel(ctx);
    const { agent, registered } = makeAgent({ cwd: '/proj' }, 'sess-1');

    listeners['agent/created']?.({ agent });
    listeners['agent/session-start']?.({ agent });

    expect(registered).toHaveLength(1);
  });

  it('skips subagent sessions, which already inherit the mint tool', () => {
    const { ctx, listeners } = makeRootCtx();
    installOverviewChannel(ctx);
    const { agent, registered } = makeAgent({ cwd: '/proj', delegationDepth: 1 }, 'sub-1');

    listeners['agent/created']?.({ agent });

    expect(registered).toEqual([]);
  });

  it('waits for the systemPrompt service instead of burning the session id', () => {
    const { ctx, listeners } = makeRootCtx();
    installOverviewChannel(ctx);
    const bare: DshContext = { on: () => () => {} };

    listeners['agent/created']?.({
      agent: { ctx: bare, session: { id: 'sess-1', header: { cwd: '/proj' } } },
    });
    // The same session id arrives again with a usable ctx: it must still register.
    const { agent, registered } = makeAgent({ cwd: '/proj' }, 'sess-1');
    listeners['agent/created']?.({ agent });

    expect(registered.map((r) => r.name)).toEqual(['mint:overview']);
  });

  it('never throws out of a listener: agent/created is serial', () => {
    const { ctx, listeners } = makeRootCtx();
    installOverviewChannel(ctx);
    const agent = {
      ctx: {
        on: () => () => {},
        systemPrompt: {
          context: () => {
            throw new Error('prompt registry closed');
          },
        },
      },
      session: { id: 'sess-1', header: { cwd: '/proj' } },
    };

    expect(() => listeners['agent/created']?.({ agent })).not.toThrow();
    expect(() => listeners['agent/created']?.({})).not.toThrow();
  });

  it('disposes both listeners', () => {
    const offs: string[] = [];
    const ctx: DshContext = {
      on: (event) => () => offs.push(event),
    };
    const dispose = installOverviewChannel(ctx);
    dispose();
    expect(offs).toEqual(['agent/created', 'agent/session-start']);
  });
});
