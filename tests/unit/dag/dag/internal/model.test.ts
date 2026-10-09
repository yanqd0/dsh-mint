import { describe, expect, it } from 'vitest';

import { isValidDagSession } from '../../../../../src/dag/dag.js';

describe('isValidDagSession', () => {
  it('accepts the ids the host hands out and the ones a URL can carry', () => {
    for (const id of ['a', 'A-1', 'sess_01', 'x'.repeat(64)]) {
      expect(isValidDagSession(id), id).toBe(true);
    }
  });

  // 路径与 id 的门禁：空串、分隔符、`..`、非 ASCII、控制字符与超长一律拒绝。
  // 逐个喂入非法样本，断言返回 false，失败信息带上被拒的那个 id。
  it('refuses anything that could escape the directory or is not an id', () => {
    for (const id of ['', 'a/b', '..', '../x', 'a.b', 'a b', 'a\nb', 'é', 'x'.repeat(65)]) {
      expect(isValidDagSession(id), JSON.stringify(id)).toBe(false);
    }
  });
});
