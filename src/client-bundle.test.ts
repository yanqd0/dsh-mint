import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Packaging contract for the browser half.
 *
 * CI runs `pnpm test:coverage` *before* `pnpm build`, so this suite must not
 * read the shipped `dist/client.js`: it runs the real build command into a temp
 * directory and inspects that artifact. What it proves is the shape the client
 * module system requires — a single `window.__ModuleLoader__.load({ id, factory })`
 * registration whose factory materializes to a plugin with `apply`/`inject`,
 * requiring only modules from the shell's frozen platform table.
 */

/** Package root: this test lives in `src/`, one level below it. */
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BUILD_SCRIPT = join(ROOT, 'scripts', 'build-client.mjs');

/** The package name, which is also the loader id and the module identity. */
const CLIENT_ID = '@yanqd0/dsh-mint';

/**
 * The modules the web boot kernel seeds before any plugin bundle runs. Mirrors
 * `PLATFORM_MODULES` in `scripts/build-client.mjs`; a specifier outside this set
 * would have to be declared in the manifest's `dsh.client.external`.
 */
const PLATFORM_MODULES = [
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

/** One registration the bundle made against the loader facade. */
interface LoaderRow {
  id: string;
  factory: (require: (specifier: string) => unknown) => Record<string, unknown>;
}

/** What one load of the bundle produced: its rows, and every `require` it made. */
interface LoadedBundle {
  rows: LoaderRow[];
  requested: string[];
}

let outfile = '';
let tempDir = '';
let code = '';

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'dsh-mint-client-'));
  outfile = join(tempDir, 'client.js');
  execFileSync(process.execPath, [BUILD_SCRIPT, '--outfile', outfile], { cwd: ROOT });
  code = readFileSync(outfile, 'utf8');
});

afterAll(() => {
  if (tempDir !== '') rmSync(tempDir, { recursive: true, force: true });
});

/** Execute the bundle in a browser-like context and capture its registration. */
function loadBundle(): LoadedBundle {
  const rows: LoaderRow[] = [];
  const window = { __ModuleLoader__: { load: (row: LoaderRow) => void rows.push(row) } };
  // A fresh V8 context with no Node globals: top-level ESM syntax would be a
  // SyntaxError here, which is itself part of what this suite asserts.
  runInNewContext(code, { window });
  return { rows, requested: [] };
}

/** Materialize the registered factory with a recording stub `require`. */
function materialize(bundle: LoadedBundle): Record<string, unknown> {
  const [row] = bundle.rows;
  if (row === undefined) throw new Error('no loader row was registered');
  return row.factory((specifier) => {
    bundle.requested.push(specifier);
    return {};
  });
}

describe('client bundle', () => {
  it('registers exactly one factory under the package name', () => {
    const { rows } = loadBundle();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(CLIENT_ID);
  });

  it('materializes into a plugin exporting apply and its service inject list', () => {
    const exports = materialize(loadBundle());
    expect(typeof exports.apply).toBe('function');
    expect(Array.from(exports.inject as string[])).toEqual([
      'slots',
      'locale',
      'sidebarRightTabs',
      'sidebarRight',
    ]);
  });

  it('requires only modules from the platform table', () => {
    const bundle = loadBundle();
    materialize(bundle);
    for (const specifier of bundle.requested) {
      expect(PLATFORM_MODULES).toContain(specifier);
    }
  });

  it('wraps esbuild output in the loader factory, not in ESM syntax', () => {
    expect(code.startsWith('window.__ModuleLoader__.load({ id: "@yanqd0/dsh-mint"')).toBe(true);
    // The source-map trailer follows the closing wrapper, so anchor on the
    // factory body's return instead of the file's last bytes.
    expect(code).toMatch(/\nreturn module\.exports;\n\} \}\);\n/);
  });
});
