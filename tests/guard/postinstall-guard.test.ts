import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { afterAll, describe, expect, it } from 'vitest';

const GUARD = join(process.cwd(), 'scripts', 'install-skill-postinstall.mjs');

/** Every scratch directory this file creates, removed again in `afterAll`. */
const scratchDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mint-postinstall-'));
  scratchDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

function run(script: string, env: NodeJS.ProcessEnv = {}): { status: number; stderr: string } {
  const result = spawnSync(process.execPath, [script], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  return { status: result.status ?? 1, stderr: result.stderr ?? '' };
}

describe('install-skill-postinstall.mjs guard', () => {
  // 降级契约：没有产物不算错误，postinstall 必须静默退出 0，绝不打断安装流程。
  // 把守卫脚本复制进只有 `scripts/` 的空布局后真跑一次，断言退出码与空 stderr。
  it('skips silently when dist/install-skill.js does not exist', () => {
    const root = tempDir();
    mkdirSync(join(root, 'scripts'), { recursive: true });
    const script = join(root, 'scripts', 'install-skill-postinstall.mjs');
    cpSync(GUARD, script);

    const result = run(script, { DSH_HOME: join(root, 'dsh') });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });

  // 尽力而为的契约：产物在就 import，抛异常也只提示不失败——装包永远不被它拖垮。
  // 同一用例跑两次：先验证 ESM stub 产物被执行，再换成抛异常的产物断言仍然退出 0。
  it('imports the entry when present and lets failures stay non-fatal', () => {
    const root = tempDir();
    mkdirSync(join(root, 'scripts'), { recursive: true });
    mkdirSync(join(root, 'dist'), { recursive: true });
    const script = join(root, 'scripts', 'install-skill-postinstall.mjs');
    cpSync(GUARD, script);
    // ESM stub entry: writes a marker file, proving the guard imported it
    writeFileSync(
      join(root, 'dist', 'install-skill.js'),
      "import { writeFileSync } from 'node:fs'; writeFileSync(process.env.MARKER, 'ran');\n"
    );

    const marker = join(root, 'marker');
    const result = run(script, { MARKER: marker });

    expect(result.status).toBe(0);
    expect(existsSync(marker)).toBe(true);

    writeFileSync(join(root, 'dist', 'install-skill.js'), "throw new Error('boom');\n");
    const broken = run(script, {});
    expect(broken.status).toBe(0);
    expect(broken.stderr).toContain('skill install failed');
  });
});
