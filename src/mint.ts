import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export const MINT_TIMEOUT_MS = 30_000;

/** Environment override for the mint entry, consulted before the mint-faa default. */
export const MINT_ENTRY_ENV = 'MINT_ENTRY';

/** Entries matching this are Node scripts; anything else is a native binary. */
const NODE_ENTRY = /\.(cjs|mjs|js)$/i;

/**
 * Resolve the mint CLI entry without relying on PATH.
 *
 * Default: `mint-faa`'s `run-mint.js` — a runtime dependency whose postinstall
 * downloads the platform binary; `createRequire` resolves it through this
 * package's own dependencies, so it works under pnpm's isolated node_modules.
 *
 * `MINT_ENTRY` overrides it, and the mount-line `mintEntry` config wins over the
 * environment. Both exist because the published `mint-faa` lags the mint repo:
 * a session that needs an unreleased subcommand points at a locally built mint.
 */
export function resolveMintEntry(): string {
  const override = process.env[MINT_ENTRY_ENV];
  if (override !== undefined && override.trim().length > 0) {
    return override.trim();
  }
  return require.resolve('mint-faa/run-mint.js');
}

/**
 * Build the spawn argv for a resolved entry.
 *
 * A `.js`/`.mjs`/`.cjs` entry is a Node script (the `mint-faa` default) and runs
 * under the host Node binary; any other path is a native mint executable and
 * spawns directly — that is what lets a session dogfood a locally built Rust
 * binary instead of the published one.
 */
export function mintCommand(entry: string): { command: string; prefix: string[] } {
  return NODE_ENTRY.test(entry)
    ? { command: process.execPath, prefix: [entry] }
    : { command: entry, prefix: [] };
}

/**
 * Shorten an entry path into something a session can afford to see on every
 * request (#58). `-V` reads the same for a debug and a release build, so the
 * entry — not just the version — is what tells the two apart.
 */
export function describeMintEntry(entry: string): string {
  // The pnpm store path is long and version-tagged: keep the interesting part.
  const faa = /mint-faa@([^/\\]+)/.exec(entry);
  if (faa?.[1] !== undefined) return `mint-faa@${faa[1]}`;
  const parts = entry.split(/[/\\]+/).filter((part) => part.length > 0);
  return parts.length <= 3 ? entry : `…/${parts.slice(-3).join('/')}`;
}

/** Extract the version out of `mint -V` output (`mint 0.8.0-alpha.1`). */
export function parseMintVersion(text: string | undefined): string | undefined {
  const match = /\bmint\s+v?(\d[^\s]*)/.exec(text ?? '');
  return match?.[1];
}

export interface MintRunOptions {
  /** Wall-clock limit for the CLI process (default {@link MINT_TIMEOUT_MS}). */
  timeoutMs?: number;
  /**
   * Mint CLI entry override: a `run-mint.js` path or a native mint binary.
   * Defaults to {@link resolveMintEntry} (`MINT_ENTRY`, else `mint-faa`).
   */
  entry?: string;
  /**
   * Cooperative cancellation. Tool executions carry `exec.signal`, and a tool
   * body is expected to observe and forward it; aborting kills the child.
   */
  signal?: AbortSignal;
}

export interface MintRunResult {
  ok: boolean;
  text?: string;
  /**
   * Raw stderr. On success this is *not* an error channel: mint writes
   * advisory lines there (e.g. the `list` pagination footer
   * `--- Page 1/1 (5 per page, 12 total) ---`), and dropping them makes a
   * paged listing look complete (#56). On failure the message also lands in
   * {@link MintRunResult.error}.
   */
  stderr?: string;
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
  options: MintRunOptions = {}
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
      const { command, prefix } = mintCommand(options.entry ?? resolveMintEntry());
      child = spawn(command, [...prefix, ...args], {
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
        settle({ ok: true, text: stdout, stderr });
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
