import { describe, expect, it, vi, beforeEach } from 'vitest';

import { runMint } from './mint.js';
import { resetProjectCache } from './cross-project.js';
import { noteOwnProject, ownProjectOf, resetOwnProjectCache } from './own-project.js';
import {
  ALLOWED_ROOT_FLAGS,
  ALLOWED_SUBCOMMANDS,
  MINT_TOOL_DESCRIPTION,
  TOOL_NAME,
  executeMintTool,
  installMintTool,
  renderMintOutcome,
  validateMintArgs,
} from './mint-tool.js';
import type { MintToolOutcome } from './mint-tool.js';
import type { DshContext, ToolDefinitionLike, ToolExecutionLike } from './types.js';

vi.mock('./mint.js', () => ({ runMint: vi.fn() }));
const runMintMock = vi.mocked(runMint);

beforeEach(() => {
  runMintMock.mockReset();
  resetProjectCache();
  resetOwnProjectCache();
  runMintMock.mockResolvedValue({ ok: true, text: 'ID\tSTATUS\n1\topen\n' });
});

function makeExec(cwd?: string, signal?: AbortSignal): ToolExecutionLike {
  return {
    name: TOOL_NAME,
    arguments: {},
    ...(cwd ? { agent: { session: { header: { cwd } } } } : {}),
    ...(signal ? { signal } : {}),
  };
}

describe('validateMintArgs', () => {
  it('accepts allowlisted root subcommands', () => {
    for (const root of ALLOWED_SUBCOMMANDS) {
      expect(validateMintArgs([root])).toBeUndefined();
    }
  });

  it('accepts normal flags, including --json and paging', () => {
    expect(validateMintArgs(['list', '--status', 'open', '--page', '2'])).toBeUndefined();
    expect(validateMintArgs(['list', '--json'])).toBeUndefined();
    expect(validateMintArgs(['plan', '--help'])).toBeUndefined();
    expect(
      validateMintArgs(['issue', 'state', 'commit', '42', '--sha', 'abc1234'])
    ).toBeUndefined();
  });

  it('rejects dangerous root subcommands with a readable reason', () => {
    for (const root of ['delete', 'import', 'sync', 'export', 'tui']) {
      expect(validateMintArgs([root])).toContain('不允许的子命令');
    }
  });

  it('rejects unknown root subcommands', () => {
    expect(validateMintArgs(['frobnicate'])).toContain('不支持的 mint 子命令');
  });

  it('accepts pure-output root flags: --help-llm and -V (#57)', () => {
    for (const root of ALLOWED_ROOT_FLAGS) {
      expect(validateMintArgs([root])).toBeUndefined();
    }
    expect(validateMintArgs(['--help-llm'])).toBeUndefined();
    expect(validateMintArgs(['-V'])).toBeUndefined();
  });

  it('rejects other root flags as unsupported options', () => {
    expect(validateMintArgs(['--frobnicate'])).toContain('不支持的 mint 顶层参数');
  });

  it('accepts a cross-project target before the subcommand (#55)', () => {
    const accepted: readonly string[][] = [
      ['-p', 'dsh-dev-dsh', 'list'],
      ['--project', 'dsh-dev-dsh', 'list'],
      ['--project=dsh-dev-dsh', 'list'],
      ['-p=dsh-dev-dsh', 'list'],
      ['-pdsh-dev-dsh', 'list'],
      ['-p', 'dsh-dev-dsh', 'issue', 'state', 'start', '5'],
    ];
    for (const argv of accepted) {
      expect(validateMintArgs(argv), argv.join(' ')).toBeUndefined();
    }
  });

  it('rejects a mispositioned, duplicated or malformed project flag (#55)', () => {
    expect(validateMintArgs(['list', '--project', 'other'])).toContain('必须放在子命令之前');
    expect(validateMintArgs(['-p', 'a', '-p', 'b', 'list'])).toContain('重复');
    expect(validateMintArgs(['-p'])).toContain('缺少项目名');
    expect(validateMintArgs(['-p', 'a/b', 'list'])).toContain('不是路径');
    expect(validateMintArgs(['-p', '..', 'list'])).toContain('项目名非法');
    expect(validateMintArgs(['-p', 'other'])).toContain('至少一个 mint 子命令');
  });

  it('rejects --db in both spellings', () => {
    expect(validateMintArgs(['list', '--db', '/tmp/x.db'])).toContain('不允许的参数');
    expect(validateMintArgs(['--db=/tmp/x.db', 'list'])).toContain('不允许的参数');
  });

  it('checks the denied subcommand after the global flags', () => {
    expect(validateMintArgs(['-p', 'other', 'delete', '42'])).toContain('不允许的子命令');
  });

  it('rejects empty or malformed argv', () => {
    expect(validateMintArgs([])).toContain('不能为空');
    expect(validateMintArgs('list')).toContain('不能为空');
    expect(validateMintArgs(['list', ''])).toContain('非空字符串');
    expect(validateMintArgs(['list', 42])).toContain('非空字符串');
  });
});

describe('executeMintTool', () => {
  it('passes argv through untouched — no --json, no paging flags injected', async () => {
    await executeMintTool('/proj', ['list']);
    expect(runMintMock).toHaveBeenCalledWith('/proj', ['list'], {});
  });

  it('returns stdout verbatim on success', async () => {
    const outcome = await executeMintTool('/proj', ['list']);
    expect(outcome).toEqual({ ok: true, exitCode: 0, stdout: 'ID\tSTATUS\n1\topen\n' });
  });

  it('passes advisory stderr through on success — mint hints (#56)', async () => {
    const hint =
      'mint: hint: found unmerged data from machine(s): mach-1; run `mint sync pull` to view the full picture';
    runMintMock.mockResolvedValue({
      ok: true,
      text: 'ID\tSTATUS\n1\topen\n',
      stderr: `${hint}\n`,
    });
    const outcome = await executeMintTool('/proj', ['list']);
    expect(outcome).toEqual({
      ok: true,
      exitCode: 0,
      stdout: 'ID\tSTATUS\n1\topen\n',
      stderr: hint,
    });
  });

  it('carries the stdout paging footer verbatim (#78)', async () => {
    runMintMock.mockResolvedValue({
      ok: true,
      text: 'ID\tSTATUS\n1\topen\n# Page 1/1 (5 per page, 1 total)\n',
    });
    const outcome = await executeMintTool('/proj', ['list']);
    expect(outcome.stdout).toContain('# Page 1/1 (5 per page, 1 total)');
  });

  it('forwards the abort signal', async () => {
    const controller = new AbortController();
    await executeMintTool('/proj', ['list'], controller.signal);
    expect(runMintMock).toHaveBeenCalledWith('/proj', ['list'], { signal: controller.signal });
  });

  it('propagates the timeout flag from a killed process (#45)', async () => {
    runMintMock.mockResolvedValueOnce({ ok: false, timedOut: true, error: 'exit timeout' });
    const outcome = await executeMintTool('/proj', ['list']);
    expect(outcome).toMatchObject({ ok: false, timedOut: true, stderr: 'exit timeout' });
  });

  it('reports a rejected argv without running mint', async () => {
    const outcome = await executeMintTool('/proj', ['delete', '42']);
    expect(outcome.ok).toBe(false);
    expect(outcome.stderr).toContain('不允许的子命令');
    expect(runMintMock).not.toHaveBeenCalled();
  });

  it('resolves a cross-project target before running mint (#80)', async () => {
    runMintMock.mockResolvedValueOnce({ ok: true, text: '[{"name":"dsh-dev-dsh"}]' });
    const outcome = await executeMintTool('/proj', ['-p', 'dsh-dev-dsh', 'list']);
    expect(outcome.ok).toBe(true);
    expect(runMintMock).toHaveBeenNthCalledWith(1, '/proj', ['project', 'list', '--json'], {});
    expect(runMintMock).toHaveBeenNthCalledWith(2, '/proj', ['-p', 'dsh-dev-dsh', 'list'], {});
  });

  it('refuses an unknown project without running mint (#80)', async () => {
    runMintMock.mockResolvedValueOnce({ ok: true, text: '[{"name":"dsh-mint"}]' });
    const outcome = await executeMintTool('/proj', ['-p', 'typo', 'list']);
    expect(outcome.ok).toBe(false);
    expect(outcome.stderr).toContain('目标项目 "typo" 不存在');
    expect(outcome.stderr).toContain('dsh-mint');
    expect(runMintMock).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the project list cannot be read (#80)', async () => {
    runMintMock.mockResolvedValueOnce({ ok: false, exitCode: 1, error: 'boom' });
    const outcome = await executeMintTool('/proj', ['-p', 'other', 'list']);
    expect(outcome.ok).toBe(false);
    expect(outcome.stderr).toContain('无法校验目标项目 "other"');
    expect(runMintMock).toHaveBeenCalledTimes(1);
  });

  it('surfaces a domain failure as a result instead of throwing', async () => {
    runMintMock.mockResolvedValue({ ok: false, exitCode: 2, error: 'invalid transition' });
    const outcome = await executeMintTool('/proj', ['issue', 'state', 'start', '42']);
    expect(outcome).toEqual({ ok: false, exitCode: 2, stderr: 'invalid transition' });
  });

  it('reports exit 130 when the run was aborted', async () => {
    runMintMock.mockResolvedValue({ ok: false, aborted: true, error: 'aborted' });
    const outcome = await executeMintTool('/proj', ['list']);
    expect(outcome).toEqual({ ok: false, exitCode: 130, stderr: 'aborted' });
  });

  it('truncates very long output', async () => {
    runMintMock.mockResolvedValue({ ok: true, text: 'x'.repeat(20_000) });
    const outcome = await executeMintTool('/proj', ['list']);
    expect(outcome.stdout).toContain('输出已截断');
    expect(outcome.stdout?.length).toBeLessThan(20_000);
  });
});

describe('renderMintOutcome', () => {
  it('renders stdout verbatim', () => {
    expect(renderMintOutcome({ ok: true, exitCode: 0, stdout: 'ID\tSTATUS' })).toBe('ID\tSTATUS');
  });

  it('renders an empty result explicitly', () => {
    expect(renderMintOutcome({ ok: true, exitCode: 0, stdout: '  \n' })).toBe('(mint 无输出)');
  });

  it('appends advisory stderr (a mint hint) after stdout', () => {
    const hint =
      'mint: hint: merged by title similarity; use --force-new to create a separate issue';
    expect(renderMintOutcome({ ok: true, exitCode: 0, stdout: 'ID\tSTATUS', stderr: hint })).toBe(
      `ID\tSTATUS\n${hint}`
    );
  });

  it('renders failures with the exit code', () => {
    expect(renderMintOutcome({ ok: false, exitCode: 2, stderr: 'boom' })).toBe(
      '[mint] exit 2: boom'
    );
  });

  it('adds a version-skew hint for unknown subcommands/arguments (#58)', () => {
    const clap = renderMintOutcome({
      ok: false,
      exitCode: 2,
      stderr: "error: unexpected argument '--help-llm' found",
    });
    expect(clap).toContain("[mint] exit 2: error: unexpected argument '--help-llm' found");
    expect(clap).toContain('版本偏斜');
    expect(clap).toContain('mintEntry');
    expect(clap).toContain('MINT_ENTRY');

    expect(
      renderMintOutcome({ ok: false, exitCode: 2, stderr: "error: unrecognized subcommand 'x'" })
    ).toContain('版本偏斜');
  });

  it('leaves unrelated failures without the skew hint', () => {
    expect(
      renderMintOutcome({ ok: false, exitCode: 1, stderr: 'invalid transition: open -> dev' })
    ).not.toContain('版本偏斜');
  });

  it('explains a killed process and points at the cold download (#45)', () => {
    const timeout = renderMintOutcome({
      ok: false,
      exitCode: 1,
      stderr: 'exit timeout',
      timedOut: true,
    });
    expect(timeout).toContain('[mint] exit 1: exit timeout');
    expect(timeout).toContain('首次调用需要先下载 mint 二进制');
    expect(timeout).toContain('mintEntry');
    expect(timeout).toContain('check-mint-entry.js');

    // Without the flag it stays a plain failure — the hint is evidence-based.
    expect(renderMintOutcome({ ok: false, exitCode: 1, stderr: 'exit timeout' })).not.toContain(
      'mintEntry'
    );
  });
});

describe('installMintTool', () => {
  it('registers the mint tool on ctx.tools', () => {
    const registered: ToolDefinitionLike[] = [];
    const ctx: DshContext = {
      on: () => () => {},
      tools: {
        register: (definition) => {
          registered.push(definition);
          return () => {};
        },
      },
    };
    const dispose = installMintTool(ctx);

    expect(dispose).toBeTypeOf('function');
    expect(registered).toHaveLength(1);
    const definition = registered[0];
    expect(definition?.name).toBe('mint');
    expect(definition?.description).toBe(MINT_TOOL_DESCRIPTION);
    expect(definition?.parameters).toMatchObject({ required: ['args'] });
  });

  it('declares every key the outcome can carry, so the host schema check passes (#100)', async () => {
    // The host validates `execute`'s return value against `output.schema` at
    // runtime, and `additionalProperties: false` makes an undeclared key fatal:
    // an undeclared `timedOut` replaced the timeout hint with
    // `INVALID_TOOL_OUTPUT` and `render` was never called.
    const registered: ToolDefinitionLike[] = [];
    installMintTool({
      on: () => () => {},
      tools: {
        register: (definition) => {
          registered.push(definition);
          return () => {};
        },
      },
    });
    const schema = registered[0]?.output.schema as {
      properties?: Record<string, unknown>;
      additionalProperties?: boolean;
    };
    expect(schema.additionalProperties).toBe(false);
    // The richest outcome there is: every optional field set at once.
    const richest: MintToolOutcome = {
      ok: false,
      exitCode: 130,
      stdout: 'out',
      stderr: 'err',
      timedOut: true,
      hint: 'hint',
    };
    for (const key of Object.keys(richest)) {
      expect(Object.keys(schema.properties ?? {})).toContain(key);
    }
    // And the timeout path really does produce one of those keys.
    runMintMock.mockResolvedValueOnce({ ok: false, timedOut: true, error: 'exit timeout' });
    const value = await registered[0]?.execute({ args: ['list'] }, makeExec());
    expect(value).toEqual({ ok: false, exitCode: 1, stderr: 'exit timeout', timedOut: true });
  });

  it('forgets the memoized project list after project create (#106)', async () => {
    runMintMock.mockImplementation((_cwd, argv) =>
      Promise.resolve(
        argv[0] === 'project' && argv[1] === 'list'
          ? { ok: true, text: '[{"name":"other"}]' }
          : { ok: true, text: 'ok' }
      )
    );
    noteOwnProject('/proj', undefined, 'dsh-mint');
    await executeMintTool('/proj', ['-p', 'other', 'list']);
    await executeMintTool('/proj', ['project', 'create', 'brand-new']);
    await executeMintTool('/proj', ['-p', 'other', 'list']);

    const probes = runMintMock.mock.calls.filter(
      ([, argv]) => argv?.[0] === 'project' && argv?.[1] === 'list'
    );
    // Two probes: the memo answered the middle call's gate path, but the
    // `project create` in between must have dropped it.
    expect(probes).toHaveLength(2);
    // The same call can re-point the cwd at another project, so the own-project
    // memo is dropped with it (#114).
    expect(ownProjectOf('/proj', undefined)).toBeUndefined();
  });

  it('attaches a correction hint when -p names the session’s own project (#114)', async () => {
    runMintMock.mockResolvedValueOnce({ ok: true, text: '[{"name":"dsh-mint"}]' });
    runMintMock.mockResolvedValueOnce({ ok: true, text: 'started' });
    noteOwnProject('/proj', undefined, 'dsh-mint');

    const outcome = await executeMintTool('/proj', [
      '-p',
      'dsh-mint',
      'issue',
      'state',
      'start',
      '5',
    ]);

    expect(outcome.ok).toBe(true);
    expect(outcome.hint).toContain('-p dsh-mint');
    expect(outcome.hint).toContain('不要带 -p');
    expect(renderMintOutcome(outcome)).toContain('started\n[mint] 提示：');
  });

  it('leaves a genuine cross-project call without a hint (#114)', async () => {
    runMintMock.mockResolvedValueOnce({ ok: true, text: '[{"name":"dsh-mint"},{"name":"other"}]' });
    runMintMock.mockResolvedValueOnce({ ok: true, text: 'ok' });
    noteOwnProject('/proj', undefined, 'dsh-mint');

    const outcome = await executeMintTool('/proj', ['-p', 'other', 'list']);

    expect(outcome.hint).toBeUndefined();
    expect(renderMintOutcome(outcome)).toBe('ok');
  });

  it('adds no hint while the own project is unknown (#114)', async () => {
    runMintMock.mockResolvedValueOnce({ ok: true, text: '[{"name":"dsh-mint"}]' });
    runMintMock.mockResolvedValueOnce({ ok: true, text: 'ok' });

    const outcome = await executeMintTool('/proj', ['-p', 'dsh-mint', 'list']);

    expect(outcome.hint).toBeUndefined();
  });

  it('degrades to a no-op without a tools service', () => {
    expect(installMintTool({ on: () => () => {} })).toBeUndefined();
  });

  it('runs mint in the session workspace and forwards the signal', async () => {
    const registered: ToolDefinitionLike[] = [];
    const ctx: DshContext = {
      on: () => () => {},
      tools: {
        register: (definition) => {
          registered.push(definition);
          return () => {};
        },
      },
    };
    installMintTool(ctx);
    const controller = new AbortController();
    await registered[0]?.execute({ args: ['list'] }, makeExec('/session/proj', controller.signal));

    expect(runMintMock).toHaveBeenCalledWith('/session/proj', ['list'], {
      signal: controller.signal,
    });
  });

  it('falls back to process.cwd() when the execution carries no session', async () => {
    const registered: ToolDefinitionLike[] = [];
    installMintTool({
      on: () => () => {},
      tools: {
        register: (definition) => {
          registered.push(definition);
          return () => {};
        },
      },
    });
    await registered[0]?.execute({ args: ['list'] }, makeExec());
    expect(runMintMock).toHaveBeenCalledWith(process.cwd(), ['list'], {});
  });
});

describe('tool description', () => {
  it('documents the mechanism, and leaves the tool-first policy to the guidance (#62)', () => {
    expect(MINT_TOOL_DESCRIPTION).toContain('零授权');
    expect(MINT_TOOL_DESCRIPTION).toContain('--help');
    expect(MINT_TOOL_DESCRIPTION).toContain('--help-llm');
    expect(MINT_TOOL_DESCRIPTION).toContain('TSV');
    // the policy sentence lives in MINT_TOOL_GUIDANCE only — not restated here
    expect(MINT_TOOL_DESCRIPTION).not.toContain('不要用 bash');
    expect(MINT_TOOL_DESCRIPTION).not.toContain('不经 bash');
  });

  it('documents cross-project targets and the survived refusal list (#55)', () => {
    expect(MINT_TOOL_DESCRIPTION).toContain('跨项目');
    expect(MINT_TOOL_DESCRIPTION).toContain('置于子命令前');
    expect(MINT_TOOL_DESCRIPTION).toContain('不可用：delete/import/sync/export/tui、--db');
    expect(MINT_TOOL_DESCRIPTION).not.toContain('--db/--project');
  });

  it('states the default project rule instead of a bare -p example (#114)', () => {
    // Every request must carry: the default is the session cwd, so own-project
    // calls take no `-p`. The old co-equal `["-p","<项目>","list"]` example is
    // what made sessions prefix their own project.
    expect(MINT_TOOL_DESCRIPTION).toContain('项目默认取会话 cwd');
    expect(MINT_TOOL_DESCRIPTION).toContain('本项目操作不要带 -p');
    expect(MINT_TOOL_DESCRIPTION).not.toContain('["-p","<项目>","list"]');
  });
});
