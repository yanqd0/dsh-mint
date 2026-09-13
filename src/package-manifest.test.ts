import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/** Package root: this test lives in `src/`, one level below it. */
const ROOT = fileURLToPath(new URL('..', import.meta.url));

interface Manifest {
  name: string;
  files?: string[];
  dsh?: { bundle?: { patch?: string } };
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
});
