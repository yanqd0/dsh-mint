import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { srcPath } from '../../helpers/repo.js';

/**
 * `dag` 模块族的边界契约：公开面与内部实现都不得碰 Node 内建。
 *
 * 客户端 bundle 会内联这一族（见 `src/client/dag-model.ts`），任何一个文件引入
 * `node:` 都会在浏览器侧炸掉，而单测跑在 Node 里察觉不到。逐文件读源码断言。
 */
describe('dag module boundaries', () => {
  it.each(['dag.ts', 'dag/internal/model.ts', 'dag/internal/validate.ts', 'dag/internal/parse-action.ts', 'dag/internal/parse-doc.ts', 'dag/internal/write.ts', 'dag/internal/graph.ts'])(
    'imports no node builtin in %s, because the browser bundle inlines it',
    (file) => {
      const source = readFileSync(srcPath('dag', file), 'utf8');
      expect(source).not.toMatch(/from 'node:/);
      expect(source).not.toMatch(/require\('node:/);
      expect(source).not.toMatch(/\bBuffer\./);
    }
  );
});
