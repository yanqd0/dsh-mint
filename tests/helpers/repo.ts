import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 仓库根定位：测试里一切「按自身位置推断路径」的唯一入口。
 *
 * 策略是从本模块所在目录**向上找最近的 `package.json`**，而不是数 `..` 的层数：
 * 测试文件一旦调整层级（0.3.0 的 `src/` + `tests/` 重构），手写的深度就会静默
 * 指到 `src/` 或 `tests/` 而不是仓库根，读到的文件要么不存在、要么是错的。
 * 生产侧同一策略见 `src/mint/mint.ts` 的 `defaultPackageRoot()`。
 */
function findRepoRoot(start: string): string {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(`repo root not found: no package.json above ${start}`);
    }
    dir = parent;
  }
}

/** 仓库根绝对路径。 */
export const REPO_ROOT = findRepoRoot(dirname(fileURLToPath(import.meta.url)));

/** 仓库根下的路径。 */
export function repoPath(...segments: string[]): string {
  return join(REPO_ROOT, ...segments);
}

/** `src/` 下的路径。 */
export function srcPath(...segments: string[]): string {
  return repoPath('src', ...segments);
}
