import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { MINT_TIMEOUT_MS, resolveMintEntry, runMint } from './mint.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
const spawnMock = vi.mocked(spawn);

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
}

function fakeChild(script: { exitCode?: number | null; stdout?: string; stderr?: string; error?: Error }): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  spawnMock.mockReturnValueOnce(child as never);
  setImmediate(() => {
    if (script.error) {
      child.emit('error', script.error);
      return;
    }
    if (script.stdout) child.stdout.emit('data', Buffer.from(script.stdout));
    if (script.stderr) child.stderr.emit('data', Buffer.from(script.stderr));
    child.emit('close', script.exitCode === undefined ? 0 : script.exitCode);
  });
  return child;
}

describe('resolveMintEntry', () => {
  it('resolves mint-faa run-mint.js via node_modules', () => {
    const entry = resolveMintEntry();
    expect(entry).toContain('mint-faa');
    expect(entry).toMatch(/run-mint\.js$/);
  });
});

describe('runMint', () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  it('spawns node with the mint entry, args, cwd and timeout', async () => {
    fakeChild({ stdout: '{"items":[]}' });
    const result = await runMint('/proj', ['list', '--json']);

    expect(result).toEqual({ ok: true, text: '{"items":[]}' });
    const [cmd, argv, options] = spawnMock.mock.calls[0] ?? [];
    expect(cmd).toBe(process.execPath);
    expect(argv?.[0]).toContain('run-mint.js');
    expect(argv).toEqual([resolveMintEntry(), 'list', '--json']);
    expect(options).toMatchObject({ cwd: '/proj', timeout: MINT_TIMEOUT_MS });
  });

  it('honours a custom timeout', async () => {
    fakeChild({ stdout: '' });
    await runMint('/proj', ['list'], { timeoutMs: 1234 });
    const [, , options] = spawnMock.mock.calls[0] ?? [];
    expect(options).toMatchObject({ timeout: 1234 });
  });

  it('resolves nonzero exit as an error, not a rejection', async () => {
    fakeChild({ exitCode: 2, stderr: 'boom' });
    const result = await runMint('/proj', ['list', '--json']);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('boom');
    expect(result.exitCode).toBe(2);
  });

  it('resolves spawn failures as an error', async () => {
    spawnMock.mockImplementationOnce(() => {
      throw new Error('ENOENT');
    });
    const result = await runMint('/proj', ['list', '--json']);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('ENOENT');
  });

  it('reports a killed process without stderr', async () => {
    fakeChild({ exitCode: null });
    const result = await runMint('/proj', ['list', '--json']);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('exit timeout');
  });

  it('returns immediately without spawning when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runMint('/proj', ['list'], { signal: controller.signal });
    expect(result).toMatchObject({ ok: false, aborted: true });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('kills the child and reports aborted when the signal fires', async () => {
    const controller = new AbortController();
    const child = fakeChild({ stdout: 'partial' });
    const pending = runMint('/proj', ['list'], { signal: controller.signal });
    controller.abort();
    const result = await pending;
    expect(result).toMatchObject({ ok: false, aborted: true, error: 'aborted' });
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('ignores a late close event after aborting', async () => {
    const controller = new AbortController();
    const child = fakeChild({ exitCode: 0, stdout: 'late' });
    const pending = runMint('/proj', ['list'], { signal: controller.signal });
    controller.abort();
    await pending;
    child.emit('close', 0);
    expect(await pending).toMatchObject({ ok: false, aborted: true });
  });
});
