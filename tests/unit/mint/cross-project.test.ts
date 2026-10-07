import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CROSS_PROJECT_REASON_PREFIX,
  PROJECT_LIST_TTL_MS,
  buildApprovalText,
  isWriteInvocation,
  listProjects,
  missingProjectMessage,
  mutatesProjectList,
  parseBashMintCalls,
  parseInvocation,
  projectFromReason,
  projectNameProblem,
  projectProbeFailureMessage,
  renderAction,
  resetProjectCache,
} from '../../../src/mint/cross-project.js';
import { runMint } from '../../../src/mint/mint.js';

vi.mock('../../../src/mint/mint.js', () => ({ runMint: vi.fn() }));
const runMintMock = vi.mocked(runMint);

beforeEach(() => {
  runMintMock.mockReset();
  resetProjectCache();
  vi.stubEnv('MINT_PROJECT', undefined);
  vi.stubEnv('MINT_DB_PATH', undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('parseInvocation — project flag shapes', () => {
  const accepted: ReadonlyArray<readonly [string[], string, string[]]> = [
    [['-p', 'other', 'list'], 'other', ['list']],
    [['--project', 'other', 'list'], 'other', ['list']],
    [['--project=other', 'list'], 'other', ['list']],
    [['-p=other', 'list'], 'other', ['list']],
    [['-pother', 'list'], 'other', ['list']],
    [['-p', 'other', 'issue', 'state', 'start', '5'], 'other', ['issue', 'state', 'start', '5']],
  ];

  it.each(accepted)('reads %j as target %s', (argv, project, rest) => {
    const invocation = parseInvocation(argv);
    expect(invocation.problem).toBeUndefined();
    expect(invocation.project).toBe(project);
    expect(invocation.projectSource).toBe('flag');
    expect(invocation.rest).toEqual(rest);
  });

  it('leaves the invocation without a project target untouched', () => {
    const invocation = parseInvocation(['list', '--status', 'open']);
    expect(invocation.project).toBeUndefined();
    expect(invocation.rest).toEqual(['list', '--status', 'open']);
  });

  it('treats a project flag after the subcommand as a position problem', () => {
    const invocation = parseInvocation(['list', '--project', 'other']);
    expect(invocation.problem).toContain('必须放在子命令之前');
  });

  it('rejects duplicated, valueless and malformed project flags', () => {
    expect(parseInvocation(['-p', 'a', '-p', 'b', 'list']).problem).toContain('重复');
    expect(parseInvocation(['-p']).problem).toContain('缺少项目名');
    expect(parseInvocation(['-p', '', 'list']).problem).toContain('不能为空');
    expect(parseInvocation(['-p', '..', 'list']).problem).toContain('项目名非法');
    expect(parseInvocation(['-p', 'a/b', 'list']).problem).toContain('不是路径');
    expect(parseInvocation(['-p', 'a\\b', 'list']).problem).toContain('不是路径');
  });

  it('falls back to MINT_PROJECT when no flag is given', () => {
    vi.stubEnv('MINT_PROJECT', 'other');
    const invocation = parseInvocation(['list']);
    expect(invocation.project).toBe('other');
    expect(invocation.projectSource).toBe('env');
  });

  it('lets the flag win over the environment', () => {
    vi.stubEnv('MINT_PROJECT', 'from-env');
    expect(parseInvocation(['-p', 'from-flag', 'list']).project).toBe('from-flag');
  });

  it('ignores an empty MINT_PROJECT', () => {
    vi.stubEnv('MINT_PROJECT', '   ');
    expect(parseInvocation(['list']).project).toBeUndefined();
  });

  it('refuses project selection in single-file MINT_DB_PATH mode', () => {
    vi.stubEnv('MINT_DB_PATH', '/tmp/one.db');
    expect(parseInvocation(['-p', 'other', 'list']).problem).toContain('单文件模式');
    expect(parseInvocation(['list']).problem).toBeUndefined();
  });

  it('keeps a value-less global flag as the root flag', () => {
    expect(parseInvocation(['-V']).rootFlag).toBe('-V');
    expect(parseInvocation(['-V']).rest).toEqual([]);
    expect(parseInvocation(['--help-llm']).rootFlag).toBe('--help-llm');
  });
});

describe('projectNameProblem', () => {
  it('accepts plain directory names and rejects everything mint rejects', () => {
    expect(projectNameProblem('dsh-dev-dsh')).toBeUndefined();
    expect(projectNameProblem('with space')).toBeUndefined();
    expect(projectNameProblem(' ')).toContain('不能为空');
    expect(projectNameProblem('.')).toContain('项目名非法');
    expect(projectNameProblem('..')).toContain('项目名非法');
    expect(projectNameProblem('/abs')).toContain('不是路径');
    expect(projectNameProblem('with\u0007bell')).toContain('控制字符');
  });
});

describe('isWriteInvocation', () => {
  /** Classify an argv the way both channels do: parse first, then judge. */
  const classify = (argv: readonly string[]): boolean => isWriteInvocation(parseInvocation(argv));

  const reads: readonly string[][] = [
    [],
    ['-V'],
    ['--version'],
    ['--help'],
    ['--help-llm'],
    ['list'],
    ['list', '--status', 'open'],
    ['show', '12'],
    ['search', 'webServer'],
    ['issue', 'list'],
    ['issue', 'show', '5'],
    ['issue', 'get', '5', 'body'],
    ['label', 'list'],
    ['plan', 'list'],
    ['plan', 'show', '3'],
    ['plan', 'get', '3', 'body'],
    ['milestone', 'list'],
    ['milestone', 'show', '2'],
    ['milestone', 'get', '2', 'version'],
    ['project', 'list'],
    ['project', 'show', '1'],
    ['project', 'get', '1', 'git'],
    // the read-only health check is not something to confirm.
    ['doctor'],
    ['doctor', '--json'],
    ['help'],
  ];

  it.each(reads)('treats %j as a read', (...argv) => {
    expect(classify(argv)).toBe(false);
  });

  const writes: readonly string[][] = [
    ['issue', 'add', 'title'],
    ['issue', 'set', '5', '--body', 'x'],
    ['issue', 'state', 'start', '5'],
    ['issue', 'link', 'create', '1', 'related', '2'],
    ['issue', 'label', 'attach', '5', 'docs'],
    ['label', 'set', 'docs'],
    ['plan', 'create', 'title'],
    ['plan', 'attach', '3', '5'],
    ['plan', 'detach', '3', '5'],
    ['plan', 'set', '3', '--title', 'x'],
    ['plan', 'plan', '3'],
    ['plan', 'close', '3'],
    ['plan', 'drop', '3'],
    ['milestone', 'create', 'title'],
    ['milestone', 'attach', '2', '5'],
    ['milestone', 'detach', '2', '5'],
    ['milestone', 'set', '2', '--status', 'done'],
    ['project', 'set', '1', '--git', 'x'],
    ['frobnicate'],
    ['issue'],
    // A help token after the subcommand is an argument or a value, never a
    // reason to downgrade the call to a read.
    ['issue', 'add', 'x', '--help'],
    ['plan', 'close', '3', '-h'],
    ['issue', 'add', '--', '--help'],
    ['issue', 'add', '--body', '--help'],
  ];

  it.each(writes)('treats %j as a write', (...argv) => {
    expect(classify(argv)).toBe(true);
  });

  it('exempts project create — it opens no existing ledger', () => {
    expect(classify(['project', 'create', 'new-project'])).toBe(false);
  });
});

describe('parseBashMintCalls', () => {
  it('finds a bare mint invocation with an explicit project', () => {
    const [invocation] = parseBashMintCalls('mint -p other issue add title');
    expect(invocation?.project).toBe('other');
    expect(invocation !== undefined && isWriteInvocation(invocation)).toBe(true);
  });

  it('finds mint inside a compound command', () => {
    const calls = parseBashMintCalls('cd ~/yanqd0/dsh-dev-dsh && mint -p other list');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.project).toBe('other');
    expect(calls[0] !== undefined && isWriteInvocation(calls[0])).toBe(false);
  });

  it('honours an inline MINT_PROJECT assignment', () => {
    const calls = parseBashMintCalls('MINT_PROJECT=other mint issue state start 5');
    expect(calls[0]?.project).toBe('other');
    expect(calls[0]?.projectSource).toBe('env');
  });

  it('recognises an absolute mint path', () => {
    expect(parseBashMintCalls('/home/u/bin/mint -p other list')[0]?.project).toBe('other');
  });

  it('leaves a session-project mint call without a target', () => {
    const calls = parseBashMintCalls('mint list --no-page');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.project).toBeUndefined();
  });

  it('ignores commands it refuses to interpret (fail-open boundary)', () => {
    for (const command of [
      'mint "list"',
      'mint -p other list > out.txt',
      "mint -p 'other' list",
      'mint -p other $(echo list)',
      'echo mint -p other list',
      'minty -p other list',
      '',
    ]) {
      expect(parseBashMintCalls(command)).toEqual([]);
    }
    expect(parseBashMintCalls(undefined)).toEqual([]);
  });
});

describe('approval text', () => {
  it('names the target project and the action in both locales', () => {
    const { reason, displayReason } = buildApprovalText('dsh-dev-dsh', [
      'issue',
      'add',
      '手册补页',
    ]);
    expect(reason.startsWith(CROSS_PROJECT_REASON_PREFIX)).toBe(true);
    expect(reason).toContain('"dsh-dev-dsh"');
    expect(displayReason.zh).toContain('dsh-dev-dsh');
    expect(displayReason.zh).toContain('issue add 手册补页');
    expect(displayReason.en).toContain('dsh-dev-dsh');
    expect(displayReason.en).toContain('issue add 手册补页');
  });

  it('round-trips the project out of its own reason', () => {
    const { reason } = buildApprovalText('dsh-dev-dsh', ['list']);
    expect(projectFromReason(reason)).toBe('dsh-dev-dsh');
    expect(projectFromReason('escalate sandbox to danger-full-access: mint')).toBeUndefined();
    expect(projectFromReason(`${CROSS_PROJECT_REASON_PREFIX}garbage`)).toBeUndefined();
    expect(projectFromReason(undefined)).toBeUndefined();
  });

  it('strips control characters and bounds the action text', () => {
    expect(renderAction(['issue', 'add', 'a\nb'])).toBe('issue add ab');
    expect(renderAction(['x'.repeat(400)])).toHaveLength(161);
  });
});

describe('project existence probe', () => {
  it('reads the project names out of project list --json', async () => {
    runMintMock.mockResolvedValue({
      ok: true,
      text: '[{"name":"bashes"},{"name":"dsh-mint"}]',
    });
    expect(await listProjects('/proj', 'mint')).toEqual(['bashes', 'dsh-mint']);
    expect(runMintMock).toHaveBeenCalledWith('/proj', ['project', 'list', '--json'], {
      entry: 'mint',
    });
  });

  it('returns undefined on a failed run or unusable payload', async () => {
    runMintMock.mockResolvedValue({ ok: false, exitCode: 1, error: 'boom' });
    expect(await listProjects('/proj')).toBeUndefined();
    runMintMock.mockResolvedValue({ ok: true, text: 'ID\tNAME\n1\tx\n' });
    expect(await listProjects('/proj')).toBeUndefined();
    runMintMock.mockResolvedValue({ ok: true, text: '{"name":"x"}' });
    expect(await listProjects('/proj')).toBeUndefined();
    runMintMock.mockResolvedValue({ ok: true, text: '[{"nope":1}]' });
    expect(await listProjects('/proj')).toBeUndefined();
    runMintMock.mockResolvedValue({ ok: true, text: '' });
    expect(await listProjects('/proj')).toBeUndefined();
  });

  it('answers both callers with one probe, until the TTL passes', async () => {
    runMintMock.mockResolvedValue({ ok: true, text: '[{"name":"other"}]' });
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(1_000);
    expect(await listProjects('/proj')).toEqual(['other']);
    now.mockReturnValue(1_000 + PROJECT_LIST_TTL_MS - 1);
    expect(await listProjects('/proj')).toEqual(['other']);
    expect(runMintMock).toHaveBeenCalledTimes(1);
    // A stale answer is re-read rather than trusted.
    now.mockReturnValue(1_000 + PROJECT_LIST_TTL_MS);
    await listProjects('/proj');
    expect(runMintMock).toHaveBeenCalledTimes(2);
    now.mockRestore();
  });

  it('scopes the memo to (cwd, entry) and forgets it on reset', async () => {
    runMintMock.mockResolvedValue({ ok: true, text: '[{"name":"other"}]' });
    await listProjects('/proj', 'mint');
    await listProjects('/other', 'mint');
    await listProjects('/proj', 'other-entry');
    expect(runMintMock).toHaveBeenCalledTimes(3);
    await listProjects('/proj', 'mint');
    expect(runMintMock).toHaveBeenCalledTimes(3);
    resetProjectCache();
    await listProjects('/proj', 'mint');
    expect(runMintMock).toHaveBeenCalledTimes(4);
  });

  it('knows which calls can change the project list', () => {
    expect(mutatesProjectList(parseInvocation(['project', 'create', 'x']))).toBe(true);
    expect(mutatesProjectList(parseInvocation(['project', 'set', '1', '--git', 'x']))).toBe(true);
    expect(mutatesProjectList(parseInvocation(['project', 'list']))).toBe(false);
    expect(mutatesProjectList(parseInvocation(['list']))).toBe(false);
  });

  it('lists the candidates in the actionable error', () => {
    const message = missingProjectMessage('typo', ['bashes', 'dsh-mint']);
    expect(message).toContain('目标项目 "typo" 不存在');
    expect(message).toContain('bashes, dsh-mint');
    expect(message).toContain('project","list');
    expect(message).toContain('单文件模式');
  });

  it('caps the candidate list', () => {
    const many = Array.from({ length: 30 }, (_, index) => `p${index}`);
    const message = missingProjectMessage('typo', many);
    expect(message).toContain('候选（30）');
    expect(message).not.toContain('p20');
  });

  it('explains a probe failure', () => {
    expect(projectProbeFailureMessage('other')).toContain('无法校验目标项目 "other"');
  });
});
