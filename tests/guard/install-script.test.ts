import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { afterAll, describe, expect, it } from 'vitest';

import { repoPath } from '../helpers/repo.js';

const SCRIPT = repoPath('scripts', 'install-dsh.sh');

/** Every scratch root this file creates, removed again in `afterAll`. */
const scratchDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mint-script-'));
  scratchDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

interface Layout {
  script: string;
  marker: string;
}

/**
 * A package layout with the wrapper in `scripts/` and a stub CLI in `dist/` that
 * records its arguments, so the test sees what the wrapper delegated.
 */
function layout(withEntry = true): Layout {
  const root = tempDir();
  mkdirSync(join(root, 'scripts'), { recursive: true });
  const script = join(root, 'scripts', 'install-dsh.sh');
  cpSync(SCRIPT, script);
  const marker = join(root, 'argv');
  if (withEntry) {
    mkdirSync(join(root, 'dist'), { recursive: true });
    writeFileSync(
      join(root, 'dist', 'install-skill.js'),
      "const { writeFileSync } = require('node:fs');\n" +
        "writeFileSync(process.env.MARKER, process.argv.slice(2).join(' '));\n"
    );
  }
  return { script, marker };
}

function run(l: Layout, args: string[]): { status: number; argv: string; stderr: string } {
  const result = spawnSync('bash', [l.script, ...args], {
    env: { ...process.env, MARKER: l.marker },
    encoding: 'utf8',
  });
  return {
    status: result.status ?? 1,
    argv: existsSync(l.marker) ? readFileSync(l.marker, 'utf8') : '',
    stderr: result.stderr ?? '',
  };
}

/**
 * `scripts/install-dsh.sh` is a thin wrapper over `dist/install-skill.js`: the
 * modes and the ownership guards must not be duplicated in shell, and
 * the historical default — the dev symlink — has to survive the delegation.
 */
describe('scripts/install-dsh.sh', () => {
  // 缺省形态的历史契约：不给模式必须等同 `--link`（开发期符号链接），`--force` 原样带上。
  // 造一份含 stub CLI 的包布局，让 stub 把收到的 argv 写进标记文件再读回断言。
  it('delegates the dev symlink form when no mode is given', () => {
    const l = layout();
    expect(run(l, [])).toMatchObject({ status: 0, argv: '--link' });
    expect(run(l, ['--force']).argv).toBe('--link --force');
  });

  it('passes explicit modes through unchanged', () => {
    const l = layout();
    expect(run(l, ['--copy']).argv).toBe('--copy');
    expect(run(l, ['--status']).argv).toBe('--status');
    expect(run(l, ['--uninstall']).argv).toBe('--uninstall');
    expect(run(l, ['--uninstall', '--force']).argv).toBe('--uninstall --force');
  });

  // 降级路径：产物缺席时必须拒绝并给出能照做的替代（`pnpm build` 与手工指令），不许瞎猜。
  // 造一份只有 wrapper、没有 `dist/install-skill.js` 的布局，跑 `--status` 断言退出码与 stderr 文案。
  it('refuses to guess without a build, and names the manual fallback', () => {
    const l = layout(false);

    const result = run(l, ['--status']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('pnpm build');
    expect(result.stderr).toContain('name: mint');
  });

  it('ships executable', () => {
    expect(statSync(SCRIPT).mode & 0o111).toBeGreaterThan(0);
  });
});
