import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/** Package root: this test lives in `src/`, one level below it. */
const ROOT = fileURLToPath(new URL('..', import.meta.url));

interface Manifest {
  name: string;
  files?: string[];
  exports?: Record<string, string>;
  dsh?: {
    bundle?: { patch?: string };
    client?: { platform?: string; inject?: string[]; external?: string[] };
  };
}

const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as Manifest;

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
});
