import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { repoPath, srcPath } from '../helpers/repo.js';

/**
 * 镜像守卫：`tests/unit/**` 与 `src/**` 结构一致。
 *
 * 规范原文见 `tests/AGENTS.md`「镜像与拆分」——源拆一份，测试就拆一份；源不拆，
 * 测试再大也不拆。这里只钉「测试有对应源」，反向（每个源都有测试）不钉：源里的
 * 纯类型与 `.tsx` 组件本来就不进 Node 单测口径。
 *
 * 两个例外都是既定的：`tests/guard/**` 守仓根契约、没有单一被测模块；被拆模块的
 * `x/internal/helpers.ts` 是共用 fixture（非 `.test.ts`，vitest 不收集）。
 */
const UNIT_DIR = repoPath('tests', 'unit');

/** `tests/unit/**` 下的用例与 fixture，相对 `tests/unit/`。 */
function testFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(join(dir, entry.name), relative);
      else if (entry.name.endsWith('.ts')) found.push(relative);
    }
  };
  walk(UNIT_DIR, '');
  return found;
}

/** 该测试路径对应的源：任一扩展名命中，或以目录形式存在（拆出的子模块）。 */
function hasSource(relative: string): boolean {
  const base = relative.replace(/\.test\.ts$/, '').replace(/\.ts$/, '');
  return (
    existsSync(srcPath(`${base}.ts`)) ||
    existsSync(srcPath(`${base}.tsx`)) ||
    existsSync(srcPath(base))
  );
}

const CASES = testFiles()
  .filter((relative) => relative.endsWith('.test.ts'))
  .map((relative) => ({ relative, source: `src/${relative.replace(/\.test\.ts$/, '')}` }));

describe('unit tests mirror src', () => {
  // 枚举守卫自身必须非空：空集会让下面每条断言真空通过（tests/AGENTS.md 契约守卫段）。
  // 直接统计 `tests/unit/**` 下收集到的用例文件数量。
  it('enumerates a non-empty test set', () => {
    expect(CASES.length).toBeGreaterThan(0);
  });

  it.each(CASES)('$relative mirrors $source', ({ relative }) => {
    expect(hasSource(relative), `${relative} has no counterpart under src/`).toBe(true);
  });

  // fixture 例外只有一处：拆出模块共用的 `internal/helpers.ts`，其余非用例文件一律不许存在。
  // 列出所有非 `.test.ts` 的文件，逐个要求落在 `helpers.ts` 上，失败信息点名违规文件。
  it('keeps the fixture escape hatch to named helpers files', () => {
    const fixtures = testFiles().filter((relative) => !relative.endsWith('.test.ts'));
    for (const relative of fixtures) {
      expect(relative, `${relative} must be named helpers.ts`).toMatch(/\/helpers\.ts$/);
    }
  });
});
