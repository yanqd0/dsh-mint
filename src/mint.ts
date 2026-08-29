import { createRequire } from 'node:module';

import type { ShellLike } from './types.js';

const require = createRequire(import.meta.url);

/**
 * Resolve the mint CLI entry (mint-faa's run-mint.js) without relying on PATH.
 *
 * `mint-faa` is a runtime dependency; its postinstall downloads the platform
 * binary. Spawning `node <entry>` works under pnpm's isolated node_modules
 * because createRequire resolves through this package's own dependencies.
 */
export function resolveMintEntry(): string {
  return require.resolve('mint-faa/run-mint.js');
}

/** Build the `node <mint-entry> <args>` command line for a shell executor. */
export function mintCommand(args: readonly string[]): string {
  return `node ${JSON.stringify(resolveMintEntry())} ${args.join(' ')}`;
}

export interface MintRunResult {
  ok: boolean;
  text?: string;
  error?: string;
}

/**
 * Run the mint CLI through the host shell.
 *
 * Nonzero exits resolve (not reject) with an error message, matching the
 * executor's contract that `run` rejects only for infrastructure failures.
 */
export async function runMint(shell: ShellLike, args: readonly string[]): Promise<MintRunResult> {
  const spec = shell.resolve({ command: mintCommand(args), timeoutMs: 30_000 });
  const result = await shell.run(spec);
  if (result.exitCode !== 0) {
    return { ok: false, error: result.stderr.text.trim() || `exit ${result.exitCode}` };
  }
  return { ok: true, text: result.stdout.text };
}
