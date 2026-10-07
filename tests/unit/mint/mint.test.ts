import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';

import {
  MINT_COLD_TIMEOUT_MS,
  MINT_ENTRY_DEPENDENCY,
  MINT_ENTRY_HINT,
  MINT_TIMEOUT_MS,
  describeMintEntry,
  expandMintEntry,
  mintCommand,
  parseMintVersion,
  resetMintWarmState,
  resolveDependencyEntry,
  resolveMintEntry,
  runMint,
} from '../../../src/mint/mint.js';

const MINT_FAA_PROBE = join('/pkg', 'node_modules', 'mint-faa', 'run-mint.js');

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
const spawnMock = vi.mocked(spawn);

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
}

function fakeChild(script: {
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  error?: Error;
}): FakeChild {
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

/**
 * A spawned child the test drives by hand: no auto-close, so a test can hold a
 * run open (cold-start serialization) or abort it mid-flight.
 */
function manualChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  spawnMock.mockReturnValueOnce(child as never);
  return child;
}

describe('resolveDependencyEntry', () => {
  it('probes the plugin package root before any bare-specifier lookup (#66)', () => {
    expect(
      resolveDependencyEntry({
        packageRoot: '/pkg',
        exists: (path) => path === MINT_FAA_PROBE,
        resolveBare: () => {
          throw new Error('the bare lookup must not run when the probe hits');
        },
      })
    ).toBe(MINT_FAA_PROBE);
  });

  it('falls back to require.resolve when the probe misses (#66)', () => {
    expect(
      resolveDependencyEntry({
        packageRoot: '/pkg',
        exists: () => false,
        resolveBare: (specifier) => `/harness/node_modules/${specifier}`,
      })
    ).toBe('/harness/node_modules/mint-faa/run-mint.js');
  });
});

describe('resolveMintEntry', () => {
  afterEach(() => {
    delete process.env.MINT_ENTRY;
  });

  it('resolves mint-faa run-mint.js via node_modules', () => {
    const entry = resolveMintEntry();
    expect(entry).toContain('mint-faa');
    expect(entry).toMatch(/run-mint\.js$/);
  });

  it('attaches the actionable hint when nothing resolves (#66)', () => {
    expect(() =>
      resolveMintEntry({
        packageRoot: '/pkg',
        exists: () => false,
        resolveBare: () => {
          throw new Error("Cannot find module 'mint-faa/run-mint.js'");
        },
      })
    ).toThrow(MINT_ENTRY_HINT);
  });
});

describe('describeMintEntry', () => {
  it('labels the pnpm-resolved mint-faa entry with its version', () => {
    expect(
      describeMintEntry('/p/node_modules/.pnpm/mint-faa@0.8.0/node_modules/mint-faa/run-mint.js')
    ).toBe('mint-faa@0.8.0');
  });

  it('names the dependency by version even when the probe path is not the store path', () => {
    expect(
      describeMintEntry(join(process.cwd(), 'node_modules', 'mint-faa', 'run-mint.js'))
    ).toMatch(/^mint-faa@\d/);
  });

  it('labels a bare command as a PATH lookup (#67)', () => {
    expect(describeMintEntry('mint')).toBe('PATH:mint');
  });

  it('follows a symlinked launcher to the build it points at (#58/#67)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-mint-entry-'));
    try {
      const target = join(dir, 'target', 'release', 'mint');
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, '#!/bin/sh\n');
      const launcher = join(dir, 'mint');
      symlinkSync(target, launcher);
      expect(describeMintEntry(launcher)).toBe('…/target/release/mint');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the last segments of a local build path — debug vs release (#58)', () => {
    expect(describeMintEntry('/repo/target/debug/mint')).toBe('…/target/debug/mint');
    expect(describeMintEntry('/repo/target/release/mint')).toBe('…/target/release/mint');
  });

  it('leaves short paths alone', () => {
    expect(describeMintEntry('target/debug/mint')).toBe('target/debug/mint');
  });
});

describe('parseMintVersion', () => {
  it('extracts the version from -V output', () => {
    expect(parseMintVersion('mint 0.8.0-alpha.1\n')).toBe('0.8.0-alpha.1');
  });

  it('returns undefined for empty or unversioned output', () => {
    expect(parseMintVersion(undefined)).toBeUndefined();
    expect(parseMintVersion('')).toBeUndefined();
    expect(parseMintVersion('mint unknown\n')).toBeUndefined();
  });
});

describe('mint entry override', () => {
  afterEach(() => {
    delete process.env.MINT_ENTRY;
  });

  it('prefers MINT_ENTRY over the mint-faa dependency', () => {
    process.env.MINT_ENTRY = '/opt/mint/run-mint.js';
    expect(resolveMintEntry()).toBe('/opt/mint/run-mint.js');
  });

  it('ignores a blank MINT_ENTRY', () => {
    process.env.MINT_ENTRY = '   ';
    expect(resolveMintEntry()).toMatch(/run-mint\.js$/);
  });

  it('lets a config sentinel force the dependency chain over an env path (#67)', () => {
    process.env.MINT_ENTRY = '/opt/mint/run-mint.js';
    expect(
      resolveMintEntry({
        entry: MINT_ENTRY_DEPENDENCY,
        packageRoot: '/pkg',
        exists: (path) => path === MINT_FAA_PROBE,
      })
    ).toBe(MINT_FAA_PROBE);
  });

  it('lets an env sentinel force the dependency chain too (#67)', () => {
    process.env.MINT_ENTRY = MINT_ENTRY_DEPENDENCY;
    expect(
      resolveMintEntry({
        packageRoot: '/pkg',
        exists: (path) => path === MINT_FAA_PROBE,
      })
    ).toBe(MINT_FAA_PROBE);
  });

  it('lets a blank config entry fall through to the environment (#67)', () => {
    process.env.MINT_ENTRY = '/opt/mint/run-mint.js';
    expect(resolveMintEntry({ entry: '   ' })).toBe('/opt/mint/run-mint.js');
  });

  it('expands a leading ~ in either knob (#67)', () => {
    expect(expandMintEntry('~/bin/mint')).toBe(join(homedir(), 'bin', 'mint'));
    expect(expandMintEntry('/opt/mint')).toBe('/opt/mint');
    process.env.MINT_ENTRY = '  ~/bin/mint  ';
    expect(resolveMintEntry()).toBe(join(homedir(), 'bin', 'mint'));
  });

  it('spawns a bare name directly so PATH resolves it (#67)', () => {
    expect(mintCommand('mint')).toEqual({ command: 'mint', prefix: [] });
  });

  it('runs a js entry through node and any other path directly', () => {
    expect(mintCommand('/pkg/run-mint.js')).toEqual({
      command: process.execPath,
      prefix: ['/pkg/run-mint.js'],
    });
    expect(mintCommand('/repo/target/debug/mint')).toEqual({
      command: '/repo/target/debug/mint',
      prefix: [],
    });
  });
});

describe('runMint', () => {
  beforeEach(() => {
    spawnMock.mockReset();
    resetMintWarmState();
    delete process.env.MINT_ENTRY;
  });

  it('spawns node with the mint entry, args, cwd and cold-start timeout (#45)', async () => {
    fakeChild({ stdout: '{"items":[]}' });
    const result = await runMint('/proj', ['list', '--json']);

    expect(result).toEqual({ ok: true, text: '{"items":[]}', stderr: '' });
    const [cmd, argv, options] = spawnMock.mock.calls[0] ?? [];
    expect(cmd).toBe(process.execPath);
    expect(argv?.[0]).toContain('run-mint.js');
    expect(argv).toEqual([resolveMintEntry(), 'list', '--json']);
    // First run of the process: mint-faa may still have to download the binary.
    expect(options).toMatchObject({ cwd: '/proj', timeout: MINT_COLD_TIMEOUT_MS });
  });

  it('drops back to the normal budget once a run succeeded (#45)', async () => {
    fakeChild({ stdout: 'ok' });
    await runMint('/proj', ['list']);
    fakeChild({ stdout: 'ok' });
    await runMint('/proj', ['list']);

    const [, , first] = spawnMock.mock.calls[0] ?? [];
    const [, , second] = spawnMock.mock.calls[1] ?? [];
    expect(first).toMatchObject({ timeout: MINT_COLD_TIMEOUT_MS });
    expect(second).toMatchObject({ timeout: MINT_TIMEOUT_MS });
  });

  it('keeps the cold budget when the first run failed (#45)', async () => {
    fakeChild({ exitCode: 2, stderr: 'download failed' });
    await runMint('/proj', ['list']);
    fakeChild({ stdout: 'ok' });
    await runMint('/proj', ['list']);

    const [, , second] = spawnMock.mock.calls[1] ?? [];
    expect(second).toMatchObject({ timeout: MINT_COLD_TIMEOUT_MS });
  });

  it('serializes concurrent first runs so they cannot race the installer (#45)', async () => {
    // Both children stay open on purpose: the second run may not spawn until the
    // first — the one that owns the cold slot — has settled.
    const held = manualChild();
    const queued = manualChild();

    const first = runMint('/proj', ['list']);
    const second = runMint('/proj', ['list']);
    await new Promise((resolve) => setImmediate(resolve));
    expect(spawnMock).toHaveBeenCalledTimes(1);

    held.emit('close', 0);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(2));
    queued.emit('close', 0);

    const [r1, r2] = await Promise.all([first, second]);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    const [, , firstOpts] = spawnMock.mock.calls[0] ?? [];
    const [, , queuedOpts] = spawnMock.mock.calls[1] ?? [];
    expect(firstOpts).toMatchObject({ timeout: MINT_COLD_TIMEOUT_MS });
    expect(queuedOpts).toMatchObject({ timeout: MINT_TIMEOUT_MS });
  });

  it('flags a killed process whose limit elapsed as timedOut (#45)', async () => {
    const held = manualChild();

    const pending = runMint('/proj', ['list'], { timeoutMs: 5 });
    await new Promise((resolve) => setTimeout(resolve, 25));
    held.emit('close', null);

    expect(await pending).toMatchObject({ ok: false, timedOut: true, error: 'exit timeout' });
  });

  it('spawns an explicit entry override directly when it is a native binary', async () => {
    fakeChild({ stdout: 'ok' });
    await runMint('/proj', ['list', '--json'], { entry: '/repo/target/debug/mint' });

    const [cmd, argv] = spawnMock.mock.calls[0] ?? [];
    expect(cmd).toBe('/repo/target/debug/mint');
    expect(argv).toEqual(['list', '--json']);
  });

  it('routes a js entry override through node', async () => {
    fakeChild({ stdout: 'ok' });
    await runMint('/proj', ['list'], { entry: '/opt/mint/run-mint.js' });

    const [cmd, argv] = spawnMock.mock.calls[0] ?? [];
    expect(cmd).toBe(process.execPath);
    expect(argv).toEqual(['/opt/mint/run-mint.js', 'list']);
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

  it('keeps advisory stderr on success — mint writes hints there (#56)', async () => {
    fakeChild({
      stdout: 'ID\tSTATUS\n1\topen\n# Page 1/1 (5 per page, 1 total)\n',
      stderr:
        'mint: hint: merged by title similarity; use --force-new to create a separate issue\n',
    });
    const result = await runMint('/proj', ['list']);
    expect(result.ok).toBe(true);
    expect(result.text).toContain('# Page 1/1');
    expect(result.stderr).toContain('--force-new');
  });

  it('resolves spawn failures as an error', async () => {
    spawnMock.mockImplementationOnce(() => {
      throw new Error('ENOENT');
    });
    const result = await runMint('/proj', ['list', '--json']);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('ENOENT');
  });

  it('reports the actionable hint when the dependency entry cannot resolve (#66)', async () => {
    const result = await runMint('/proj', ['-V'], {
      entry: MINT_ENTRY_DEPENDENCY,
      packageRoot: '/pkg',
      exists: () => false,
      resolveBare: () => {
        throw new Error("Cannot find module 'mint-faa/run-mint.js'");
      },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain(MINT_ENTRY_HINT);
    expect(result.error).toContain('Cannot find module');
    expect(spawnMock).not.toHaveBeenCalled();
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
    const child = manualChild();
    const pending = runMint('/proj', ['list'], { signal: controller.signal });
    // The cold slot resolves on a microtask, so let the spawn happen first.
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    const result = await pending;
    expect(result).toMatchObject({ ok: false, aborted: true, error: 'aborted' });
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('ignores a late close event after aborting', async () => {
    const controller = new AbortController();
    const child = manualChild();
    const pending = runMint('/proj', ['list'], { signal: controller.signal });
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    await pending;
    child.emit('close', 0);
    expect(await pending).toMatchObject({ ok: false, aborted: true });
  });
});
