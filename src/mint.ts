import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export const MINT_TIMEOUT_MS = 30_000;

/**
 * Resolve the mint CLI entry (mint-faa's run-mint.js) without relying on PATH.
 *
 * `mint-faa` is a runtime dependency; its postinstall downloads the platform
 * binary. `createRequire` resolves through this package's own dependencies, so
 * it works under pnpm's isolated node_modules.
 */
export function resolveMintEntry(): string {
  return require.resolve('mint-faa/run-mint.js');
}

export interface MintRunOptions {
  /** Wall-clock limit for the CLI process (default {@link MINT_TIMEOUT_MS}). */
  timeoutMs?: number;
  /**
   * Cooperative cancellation. Tool executions carry `exec.signal`, and a tool
   * body is expected to observe and forward it; aborting kills the child.
   */
  signal?: AbortSignal;
}

export interface MintRunResult {
  ok: boolean;
  text?: string;
  error?: string;
  /** Process exit code when the CLI ran and failed; absent on abort/timeout. */
  exitCode?: number;
  /** True when the run was cancelled through `options.signal`. */
  aborted?: boolean;
}

/**
 * Run the mint CLI by spawning `node <mint-entry>` directly.
 *
 * Plugin code is host-trusted, and its own child processes do not pass through
 * the session file sandbox (`ctx.shell` / Seatbelt), so mint can read and write
 * its data directory even in `workspace-write` sessions (#18).
 *
 * Nonzero exits and spawn failures resolve (not reject) with an error message,
 * matching the old shell-backed contract so callers never need to catch.
 */
export function runMint(
  cwd: string,
  args: readonly string[],
  options: MintRunOptions = {},
): Promise<MintRunResult> {
  const timeoutMs = options.timeoutMs ?? MINT_TIMEOUT_MS;
  const { signal } = options;

  return new Promise((resolvePromise) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    let aborted = signal?.aborted === true;
    let child: ChildProcess | undefined;

    const settle = (result: MintRunResult): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolvePromise(result);
    };

    function onAbort(): void {
      aborted = true;
      try {
        child?.kill('SIGTERM');
      } catch {
        // already gone — the close handler settles
      }
      settle({ ok: false, aborted: true, error: 'aborted' });
    }

    function cleanup(): void {
      signal?.removeEventListener('abort', onAbort);
    }

    if (aborted) {
      settle({ ok: false, aborted: true, error: 'aborted' });
      return;
    }

    try {
      child = spawn(process.execPath, [resolveMintEntry(), ...args], {
        cwd,
        timeout: timeoutMs,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      settle({ ok: false, error: error instanceof Error ? error.message : String(error) });
      return;
    }

    signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (error) => {
      settle({ ok: false, error: error.message });
    });
    child.on('close', (code) => {
      if (aborted) {
        settle({ ok: false, aborted: true, error: 'aborted' });
        return;
      }
      if (code === 0) {
        settle({ ok: true, text: stdout });
        return;
      }
      if (code === null) {
        settle({ ok: false, error: 'exit timeout' });
        return;
      }
      settle({ ok: false, exitCode: code, error: stderr.trim() || `exit ${code}` });
    });
  });
}
