import { spawn } from 'node:child_process';
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

export interface MintRunResult {
  ok: boolean;
  text?: string;
  error?: string;
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
  timeoutMs: number = MINT_TIMEOUT_MS,
): Promise<MintRunResult> {
  return new Promise((resolvePromise) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    const settle = (result: MintRunResult): void => {
      if (settled) return;
      settled = true;
      resolvePromise(result);
    };

    let child;
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

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (error) => {
      settle({ ok: false, error: error.message });
    });
    child.on('close', (code) => {
      if (code === 0) settle({ ok: true, text: stdout });
      else settle({ ok: false, error: stderr.trim() || `exit ${code ?? 'timeout'}` });
    });
  });
}
