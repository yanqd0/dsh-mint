import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

export const MINT_TIMEOUT_MS = 30_000;

/**
 * Wall-clock limit for the **first** mint run of a process (#45).
 *
 * A fresh install has no mint binary yet: `mint-faa` downloads the GitHub
 * release lazily on first use, and that download can exceed 30 s on a slow link.
 * The first run therefore gets a much larger budget; every later run is warm and
 * stays on {@link MINT_TIMEOUT_MS}.
 */
export const MINT_COLD_TIMEOUT_MS = 180_000;

/** Environment override for the mint entry, consulted before the mint-faa default. */
export const MINT_ENTRY_ENV = 'MINT_ENTRY';

/**
 * Sentinel `mintEntry`/`MINT_ENTRY` value that forces the dependency chain even
 * when the other knob carries a path override (#67) — what a user-env check
 * needs while the dev profile is pinned to a local build.
 */
export const MINT_ENTRY_DEPENDENCY = 'dependency';

/** Entries matching this are Node scripts; anything else is a native binary. */
const NODE_ENTRY = /\.(cjs|mjs|js)$/i;

/** Package-relative path of the wrapper shipped by the `mint-faa` dependency. */
const MINT_FAA_ENTRY = join('node_modules', 'mint-faa', 'run-mint.js');

/**
 * Actionable failure text for the tool channel (#66). A bare
 * `Cannot find module 'mint-faa/run-mint.js'` reads like a plugin bug with no
 * way out; this names the two overrides and the profile-side fix.
 */
export const MINT_ENTRY_HINT =
  'mint 入口解析失败：mint-faa 依赖不可见（DSH 下插件裸包名由 harness/profile 作用域解析，' +
  'link: 安装也不会把被 link 包的依赖装进 profile）。' +
  '请在挂载行 config.mintEntry 指定入口（如 ~/bin/mint 或本地构建 target/release/mint），' +
  '或设置 MINT_ENTRY 后重启 harness；依赖链需在 profile 内 ' +
  'dsh plugin --profile <p> approve-builds --all 后重装。';

/**
 * One-line variant for the per-request `[Mint]` overview (#66). Only rendered on
 * failure, so it never enters the #61 every-request budget.
 */
export const MINT_ENTRY_WARNING =
  'mint 入口解析失败（mint-faa 不可见）→ 挂载行 mintEntry（如 ~/bin/mint）或 MINT_ENTRY，改后重启 harness';

/**
 * Seams for {@link resolveMintEntry}; all optional, the production path leaves
 * every one at its default.
 */
export interface MintEntryOptions {
  /**
   * Entry override (`mintEntry` on the mount line; `MintRunOptions.entry` at
   * call time): a `run-mint.js` path, a native mint binary, a `~`-prefixed
   * path, a bare `PATH` command, or the {@link MINT_ENTRY_DEPENDENCY} sentinel.
   * Wins over the `MINT_ENTRY` environment.
   */
  entry?: string;
  /** Package root probed for the bundled dependency (tests point it at a fixture). */
  packageRoot?: string;
  /** Filesystem probe seam (`fs.existsSync`). */
  exists?: (path: string) => boolean;
  /** Bare-specifier resolver seam (`createRequire(...).resolve`). */
  resolveBare?: (specifier: string) => string;
}

/** Package root of this plugin: `dist/x.js` and `src/x.ts` both sit one level below it. */
function defaultPackageRoot(): string {
  return fileURLToPath(new URL('..', import.meta.url));
}

/** Expand a leading `~` — a mount-line YAML value never sees a shell. */
export function expandMintEntry(entry: string): string {
  if (entry === '~') return homedir();
  if (entry.startsWith('~/')) return join(homedir(), entry.slice(2));
  return entry;
}

/**
 * Locate `mint-faa`'s `run-mint.js` **without a bare-specifier lookup first**.
 *
 * DSH resolves a plugin's bare specifiers through the harness/profile package
 * table (`notes/dsh-plugin-dev.md`), where the plugin's own dependency is
 * invisible — that is the `Cannot find module 'mint-faa/run-mint.js'` outage
 * (#66). Probing the plugin's own package root works for pnpm (isolated and
 * hoisted) and npm layouts alike; `require.resolve` stays as the fallback for
 * layouts this probe does not cover.
 */
export function resolveDependencyEntry(options: MintEntryOptions = {}): string {
  const root = options.packageRoot ?? defaultPackageRoot();
  const probe = join(root, MINT_FAA_ENTRY);
  const exists = options.exists ?? existsSync;
  if (exists(probe)) return probe;
  const resolveBare = options.resolveBare ?? ((specifier: string) => require.resolve(specifier));
  return resolveBare('mint-faa/run-mint.js');
}

/** {@link resolveDependencyEntry} with {@link MINT_ENTRY_HINT} attached on failure. */
function dependencyEntry(options: MintEntryOptions): string {
  try {
    return resolveDependencyEntry(options);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${MINT_ENTRY_HINT} (${detail})`);
  }
}

/**
 * Resolve the mint CLI entry.
 *
 * Precedence: mount-line `mintEntry` config → `MINT_ENTRY` environment → the
 * `mint-faa` dependency ({@link MINT_ENTRY_DEPENDENCY} at either knob forces
 * the last one). An explicit entry may be a `run-mint.js` path, a native mint
 * binary, a `~`-prefixed path, or a bare command name that `spawn` resolves
 * through `PATH`.
 *
 * The dependency range (`>=0.8.0 <1.0.0`) already lets a user pick up any
 * pre-1.0 `mint-faa` without a plugin release; the overrides cover what a range
 * cannot — dogfooding an unreleased or locally built mint.
 */
export function resolveMintEntry(options: MintEntryOptions = {}): string {
  const configured = options.entry?.trim();
  if (configured !== undefined && configured.length > 0) {
    return configured === MINT_ENTRY_DEPENDENCY
      ? dependencyEntry(options)
      : expandMintEntry(configured);
  }
  const fromEnv = process.env[MINT_ENTRY_ENV]?.trim();
  if (fromEnv !== undefined && fromEnv.length > 0 && fromEnv !== MINT_ENTRY_DEPENDENCY) {
    return expandMintEntry(fromEnv);
  }
  return dependencyEntry(options);
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
 * Shorten an entry into something a session can afford to see on every request
 * (#58). `-V` reads the same for a debug and a release build, so the entry —
 * not just the version — is what tells the two apart; a symlinked launcher
 * (`~/bin/mint`) is resolved first so the label names the actual build
 * (`…/target/release/mint`).
 */
export function describeMintEntry(entry: string): string {
  if (!entry.includes('/') && !entry.includes('\\')) return `PATH:${entry}`;
  let resolved = entry;
  try {
    resolved = realpathSync(entry);
  } catch {
    // Not on disk (or not readable) — describe what the user wrote.
  }
  // The pnpm store path is long and version-tagged: keep the interesting part.
  const faa = /mint-faa@([^/\\]+)/.exec(resolved);
  if (faa?.[1] !== undefined) return `mint-faa@${faa[1]}`;
  const parts = resolved.split(/[/\\]+/).filter((part) => part.length > 0);
  return parts.length <= 3 ? resolved : `…/${parts.slice(-3).join('/')}`;
}

/** Extract the version out of `mint -V` output (`mint 0.8.0-alpha.1`). */
export function parseMintVersion(text: string | undefined): string | undefined {
  const match = /\bmint\s+v?(\d[^\s]*)/.exec(text ?? '');
  return match?.[1];
}

export interface MintRunOptions extends MintEntryOptions {
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
  /**
   * Raw stderr. On success this is *not* an error channel: mint writes
   * advisory lines there (`mint: hint: …`, e.g. a dedup merge suggestion or an
   * unmerged-machine warning) and dropping them hides an actionable note
   * (#56). The `list` pagination footer is no longer one of them — since mint
   * 0.8 it is written to stdout (`# Page x/y`), so the stdout path carries it
   * (#78). On failure the message also lands in {@link MintRunResult.error}.
   */
  stderr?: string;
  error?: string;
  /** Process exit code when the CLI ran and failed; absent on abort/timeout. */
  exitCode?: number;
  /**
   * True when the child was killed by the wall-clock limit (#45). Only set on the
   * failure path: a run that finished within its budget never carries it. Callers
   * turn it into the cold-download hint instead of a bare `exit timeout`.
   */
  timedOut?: boolean;
  /** True when the run was cancelled through `options.signal`. */
  aborted?: boolean;
}

/**
 * Process-wide cold-start bookkeeping (#45).
 *
 * The session-start overview fires three mint calls concurrently, and
 * `mint-faa`'s lazy installer removes the binary directory before downloading
 * with no lock — parallel first runs would destroy each other's install. So the
 * **first** run holds a slot: concurrent callers wait for it instead of spawning
 * a second cold install. The slot is released on every settle, and only a
 * *successful* cold run marks the process warm, so a failed download does not
 * downgrade the next attempt to the 30 s budget.
 */
let mintWarmed = false;
let coldRun: Promise<void> | undefined;
let releaseColdRun: (() => void) | undefined;

/** Test seam: forget the process-wide cold-start state. */
export function resetMintWarmState(): void {
  mintWarmed = false;
  coldRun = undefined;
  releaseColdRun = undefined;
}

/**
 * Take the cold slot, or wait for the run that holds it (and re-check afterwards:
 * a failed holder hands the slot on instead of leaving callers warm).
 */
async function acquireColdSlot(): Promise<boolean> {
  while (!mintWarmed) {
    if (coldRun === undefined) {
      coldRun = new Promise<void>((resolve) => {
        releaseColdRun = resolve;
      });
      return true;
    }
    await coldRun;
  }
  return false;
}

/** Release the cold slot taken by {@link acquireColdSlot}. */
function settleColdSlot(ok: boolean): void {
  if (ok) mintWarmed = true;
  const release = releaseColdRun;
  coldRun = undefined;
  releaseColdRun = undefined;
  release?.();
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
 *
 * `options.timeoutMs` is the caller's own budget and opts out of the cold-start
 * bookkeeping (#45); otherwise the first run of the process gets
 * {@link MINT_COLD_TIMEOUT_MS} and later ones {@link MINT_TIMEOUT_MS}.
 */
export async function runMint(
  cwd: string,
  args: readonly string[],
  options: MintRunOptions = {}
): Promise<MintRunResult> {
  const explicitTimeout = options.timeoutMs;
  const cold = explicitTimeout === undefined ? await acquireColdSlot() : false;
  const timeoutMs = explicitTimeout ?? (cold ? MINT_COLD_TIMEOUT_MS : MINT_TIMEOUT_MS);
  const { signal } = options;

  return new Promise((resolvePromise) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    let aborted = signal?.aborted === true;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let child: ChildProcess | undefined;

    const settle = (result: MintRunResult): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (cold) settleColdSlot(result.ok === true);
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
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      signal?.removeEventListener('abort', onAbort);
    }

    if (aborted) {
      settle({ ok: false, aborted: true, error: 'aborted' });
      return;
    }

    // Armed before spawn so it is registered ahead of spawn's own timeout timer
    // for the same deadline: by the time the killed child closes, the flag is
    // already set and `code === null` can be reported as a timeout rather than a
    // bare crash (#45).
    timer = setTimeout(() => {
      timedOut = true;
    }, timeoutMs);

    try {
      const { command, prefix } = mintCommand(resolveMintEntry(options));
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
        settle({ ok: false, ...(timedOut ? { timedOut: true } : {}), error: 'exit timeout' });
        return;
      }
      settle({ ok: false, exitCode: code, error: stderr.trim() || `exit ${code}` });
    });
  });
}
