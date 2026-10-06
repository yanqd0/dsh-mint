import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/** Package root: this test lives in `src/`, one level below it. */
const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** The client locales DSH ships; display dictionaries exist for each of them. */
const LOCALES = ['en', 'zh'] as const;

/** One `locale/<language>.json` as the DSH metadata reader expects it. */
interface LocaleDictionary {
  meta?: { title?: string; description?: string };
}

interface Manifest {
  name: string;
  description?: string;
  files?: string[];
  exports?: Record<string, string>;
  dsh?: {
    bundle?: { patch?: string };
    client?: { platform?: string; inject?: string[]; external?: string[] };
  };
}

const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as Manifest;

/** Read one shipped display dictionary. */
function dictionary(locale: (typeof LOCALES)[number]): LocaleDictionary {
  return JSON.parse(
    readFileSync(join(ROOT, 'locale', `${locale}.json`), 'utf8')
  ) as LocaleDictionary;
}

/**
 * Packaging contract for the bundle self-mount: DSH mounts a package only when
 * the installed package declares `dsh.bundle.patch` (see `dsh-app-boot`), and a
 * declared patch file that never shipped in the tarball would break every
 * install. Both halves are asserted here, plus the plugin id the patch uses.
 */
describe('package manifest', () => {
  it('declares the DSH bundle patch, so `dsh plugin add` mounts the plugin', () => {
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml');
  });

  it('ships the declared bundle patch in the tarball', () => {
    expect(manifest.files).toContain('dist');
    expect(manifest.files).toContain('cordis.patch.yml');
  });

  it('mounts this package under the plugin id `mint`', () => {
    const patch = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8');
    expect(patch).toMatch(/^- insert:/m);
    expect(patch).toContain(`name: '${manifest.name}'`);
    expect(patch).toContain('- id: mint');
  });

  // The host validates the entry config against the exported zod object, and a
  // missing `config` key fails that validation (`invalid config: - Required`) —
  // an empty object makes every field fall back to its zod default.
  it('carries an explicit config object, so the mount validates', () => {
    const patch = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8');
    expect(patch).toMatch(/^\s+config: \{\}$/m);
  });

  // The client half reaches the page only through this declaration: the module
  // system scans *mounted* rows for `dsh.client`, serves the `./client` export
  // over `/plugins`, and fails activation loudly when the bundle is missing.
  describe('client half', () => {
    it('declares a web client with the prebuilt bundle as its `./client` export', () => {
      expect(manifest.dsh?.client?.platform).toBe('web');
      expect(manifest.exports?.['./client']).toBe('./dist/client.js');
      expect(manifest.files).toContain('dist');
    });

    // The sidebar's tab registry is provided by another client plugin, so the
    // browser half has no seat to register into until that bundle arrived.
    it('waits for the right-sidebar client bundle', () => {
      expect(manifest.dsh?.client?.inject).toContain(
        '@deepseek-ai/dsh-client-ui-sidebar-right'
      );
    });

    // Everything the bundle requires must come from the shell's frozen platform
    // table; anything else needs an `external` entry naming the row that
    // provides it, and an undeclared request fails at materialization.
    it('requires nothing outside the platform module table', () => {
      expect(manifest.dsh?.client?.external ?? []).toEqual([]);
    });
  });

  /**
   * The plugin page reads a package's display text through `readPluginMeta`
   * (`@deepseek-ai/dsh-app-boot`; consumers: `dsh-host-plugin-inventory` and
   * `dsh-plugin-manager`). It resolves `<pkg>/package.json` and
   * `<pkg>/locale/en.json` **through the Node resolver**, and a package that
   * declares `exports` without those subpaths fails both with
   * `ERR_PACKAGE_PATH_NOT_EXPORTED` — which the reader swallows silently, so the
   * page shows the bare package name and no description at all (issue #127).
   *
   * The checks below resolve the very same subpaths by self-reference, which is
   * the same resolver rule, without needing an installed harness.
   */
  describe('plugin display metadata', () => {
    it('exports the subpaths the DSH metadata reader resolves', () => {
      const manifestRequire = createRequire(join(ROOT, 'package.json'));
      expect(realpathSync(manifestRequire.resolve(`${manifest.name}/package.json`))).toBe(
        realpathSync(join(ROOT, 'package.json'))
      );
      for (const locale of LOCALES) {
        expect(
          realpathSync(manifestRequire.resolve(`${manifest.name}/locale/${locale}.json`))
        ).toBe(realpathSync(join(ROOT, 'locale', `${locale}.json`)));
      }
    });

    it('ships the dictionaries in the tarball', () => {
      expect(manifest.files).toContain('locale/*.json');
    });

    // The reader enumerates the directory that holds `en.json`, and every file
    // in it must be named after a language id: a stray name fails the whole
    // record instead of one language.
    it('ships exactly the built-in locales', () => {
      const shipped = readdirSync(join(ROOT, 'locale')).sort();
      expect(shipped).toEqual(LOCALES.map((locale) => `${locale}.json`).sort());
    });

    it('carries a title and a description in every locale', () => {
      for (const locale of LOCALES) {
        const { meta } = dictionary(locale);
        expect(meta?.title).toBe('Mint');
        expect((meta?.description ?? '').length).toBeGreaterThan(0);
      }
    });

    // The npm one-liner and the English line on the plugin page are one
    // sentence, so the registry and the page cannot drift apart.
    it('keeps the English dictionary identical to the npm description', () => {
      expect(dictionary('en').meta?.description).toBe(manifest.description);
    });

    // The description is where a user reads what the plugin does and where its
    // panel opens; both facts are part of the contract, not incidental copy.
    it('names the mint support and the panel location', () => {
      const zh = dictionary('zh').meta?.description ?? '';
      const en = dictionary('en').meta?.description ?? '';
      expect(zh).toContain('mint');
      expect(zh).toContain('侧边栏');
      expect(en).toContain('mint');
      expect(en).toContain('sidebar');
    });
  });
});
