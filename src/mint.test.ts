import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';

import { MINT_TIMEOUT_MS, resolveMintEntry, runMint } from './mint.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
const spawnMock = vi.mocked(spawn);

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
}

function fakeChild(script: { exitCode?: number | null; stdout?: string; stderr?: string; error?: Error }): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
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

  it('resolves nonzero exit as an error, not a rejection', async () => {
    fakeChild({ exitCode: 2, stderr: 'boom' });
    const result = await runMint('/proj', ['list', '--json']);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('boom');
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
});
