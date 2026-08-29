import { createRequire } from 'node:module';

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
