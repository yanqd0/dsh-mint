#!/usr/bin/env node
/**
 * Build the browser half of dsh-mint into `dist/client.js`.
 *
 * The DSH client module system serves `exports["./client"]` and executes it as
 * a bundle that *registers a factory* — one module identity per package, with
 * the shell's own `require` for everything it seeded. The built file therefore
 * has to be exactly this shape:
 *
 *     window.__ModuleLoader__.load({ id: '@yanqd0/dsh-mint', factory: (require) => { … } })
 *
 * The banner/footer below supply that wrapper around esbuild's CommonJS output,
 * which is a self-contained module body expecting `module` / `exports` to exist
 * (the loader memoizes whatever `return module.exports` yields).
 *
 * Every specifier resolved by `require` comes from the shell's frozen platform
 * table; anything else would need a `dsh.client.external` declaration.
 *
 * Usage: `node scripts/build-client.mjs [--outfile <path>]`
 */
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { build } from 'esbuild';

/** Package root: this script lives in `scripts/`, one level below it. */
const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Loader id and browser module identity — the package name. */
export const CLIENT_ID = '@yanqd0/dsh-mint';

/**
 * Modules the web boot kernel seeds before any plugin bundle runs. Marking them
 * external keeps React's identity shared with the shell and keeps the UI
 * libraries out of the package.
 */
export const PLATFORM_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
];

/** Registration wrapper: opens the factory and gives esbuild's CJS body its scope. */
const BANNER =
  `window.__ModuleLoader__.load({ id: ${JSON.stringify(CLIENT_ID)}, factory: (require) => {\n` +
  '"use strict";\n' +
  'var module = { exports: {} };\n' +
  'var exports = module.exports;\n';

/** Closes the factory and hands the loader the module the CJS body produced. */
const FOOTER = '\nreturn module.exports;\n} });\n';

/** The bundle this package ships (the `./client` export). */
export const DEFAULT_OUTFILE = join(ROOT, 'dist', 'client.js');
const ENTRY = join(ROOT, 'src', 'client', 'index.tsx');

/**
 * Build `src/client/index.tsx` into the loader factory bundle.
 *
 * @param options - `outfile` overrides the shipped path (tests build into a temp
 *   directory, because CI runs tests before `pnpm build`).
 * @returns the absolute path written.
 */
export async function buildClient(options = {}) {
  const { outfile = DEFAULT_OUTFILE } = options;
  mkdirSync(dirname(outfile), { recursive: true });
  await build({
    entryPoints: [ENTRY],
    outfile,
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    jsx: 'automatic',
    external: PLATFORM_MODULES,
    sourcemap: true,
    banner: { js: BANNER },
    footer: { js: FOOTER },
    logLevel: 'warning',
  });
  return outfile;
}

/** Read `--outfile <path>`; anything else is a mistake worth reporting. */
function outfileFromArgv(argv) {
  const index = argv.indexOf('--outfile');
  if (index === -1) return DEFAULT_OUTFILE;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error('build-client: --outfile needs a path');
  }
  return resolve(value);
}

/** True when this file is the process entry point, not an import from a test. */
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedDirectly) {
  const outfile = await buildClient({ outfile: outfileFromArgv(process.argv.slice(2)) });
  process.stdout.write(`dsh-mint: client bundle → ${outfile}\n`);
}
