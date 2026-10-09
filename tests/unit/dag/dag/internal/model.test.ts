import { describe, expect, it } from 'vitest';

import { isValidDagSession } from '../../../../../src/dag/dag.js';

describe('isValidDagSession', () => {
  it('accepts the ids the host hands out and the ones a URL can carry', () => {
    for (const id of ['a', 'A-1', 'sess_01', 'x'.repeat(64)]) {
      expect(isValidDagSession(id), id).toBe(true);
    }
  });

  it('refuses anything that could escape the directory or is not an id', () => {
    for (const id of ['', 'a/b', '..', '../x', 'a.b', 'a b', 'a\nb', 'é', 'x'.repeat(65)]) {
      expect(isValidDagSession(id), JSON.stringify(id)).toBe(false);
    }
  });
});
