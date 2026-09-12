import { describe, expect, it, vi, beforeEach } from 'vitest';

import { runMint } from './mint.js';
import {
  ALLOWED_SUBCOMMANDS,
  MINT_TOOL_DESCRIPTION,
  TOOL_NAME,
  executeMintTool,
  installMintTool,
  renderMintOutcome,
  validateMintArgs,
} from './mint-tool.js';
import type { DshContext, ToolDefinitionLike, ToolExecutionLike } from './types.js';

vi.mock('./mint.js', () => ({ runMint: vi.fn() }));
const runMintMock = vi.mocked(runMint);

beforeEach(() => {
  runMintMock.mockReset();
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
    expect(validateMintArgs(['issue', 'state', 'commit', '42', '--sha', 'abc1234'])).toBeUndefined();
  });

  it('rejects dangerous root subcommands with a readable reason', () => {
    for (const root of ['delete', 'import', 'sync', 'export', 'tui']) {
      expect(validateMintArgs([root])).toContain('不允许的子命令');
    }
  });

  it('rejects unknown root subcommands', () => {
    expect(validateMintArgs(['frobnicate'])).toContain('不支持的 mint 子命令');
  });

  it('rejects flags that escape the session project context', () => {
    expect(validateMintArgs(['list', '--db', '/tmp/x.db'])).toContain('不允许的参数');
    expect(validateMintArgs(['--project', 'other', 'list'])).toContain('不允许的参数');
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

  it('forwards the abort signal', async () => {
    const controller = new AbortController();
    await executeMintTool('/proj', ['list'], controller.signal);
    expect(runMintMock).toHaveBeenCalledWith('/proj', ['list'], { signal: controller.signal });
  });

  it('reports a rejected argv without running mint', async () => {
    const outcome = await executeMintTool('/proj', ['delete', '42']);
    expect(outcome.ok).toBe(false);
    expect(outcome.stderr).toContain('不允许的子命令');
    expect(runMintMock).not.toHaveBeenCalled();
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

  it('renders failures with the exit code', () => {
    expect(renderMintOutcome({ ok: false, exitCode: 2, stderr: 'boom' })).toBe('[mint] exit 2: boom');
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

    expect(runMintMock).toHaveBeenCalledWith('/session/proj', ['list'], { signal: controller.signal });
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
  it('states the zero-approval property and points at --help', () => {
    expect(MINT_TOOL_DESCRIPTION).toContain('不经 bash');
    expect(MINT_TOOL_DESCRIPTION).toContain('--help');
    expect(MINT_TOOL_DESCRIPTION).toContain('TSV');
  });
});
