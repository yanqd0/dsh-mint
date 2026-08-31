import { cpSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

const GUARD = join(process.cwd(), 'scripts', 'install-skill-postinstall.mjs');

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-mint-postinstall-'));
}

function run(script: string, env: NodeJS.ProcessEnv = {}): { status: number; stderr: string } {
  const result = spawnSync(process.execPath, [script], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  return { status: result.status ?? 1, stderr: result.stderr ?? '' };
}

describe('install-skill-postinstall.mjs guard (#34)', () => {
  it('skips silently when dist/install-skill.js does not exist', () => {
    const root = tempDir();
    mkdirSync(join(root, 'scripts'), { recursive: true });
    const script = join(root, 'scripts', 'install-skill-postinstall.mjs');
    cpSync(GUARD, script);

    const result = run(script, { DSH_HOME: join(root, 'dsh') });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('imports the entry when present and lets failures stay non-fatal', () => {
    const root = tempDir();
    mkdirSync(join(root, 'scripts'), { recursive: true });
    mkdirSync(join(root, 'dist'), { recursive: true });
    const script = join(root, 'scripts', 'install-skill-postinstall.mjs');
    cpSync(GUARD, script);
    // ESM stub entry: writes a marker file, proving the guard imported it
    writeFileSync(
      join(root, 'dist', 'install-skill.js'),
      "import { writeFileSync } from 'node:fs'; writeFileSync(process.env.MARKER, 'ran');\n",
    );

    const marker = join(root, 'marker');
    const result = run(script, { MARKER: marker });

    expect(result.status).toBe(0);
    expect(existsSync(marker)).toBe(true);

    // a throwing entry still exits 0 (best-effort contract)
    writeFileSync(join(root, 'dist', 'install-skill.js'), "throw new Error('boom');\n");
    const broken = run(script, {});
    expect(broken.status).toBe(0);
    expect(broken.stderr).toContain('skill install failed');
  });
});
