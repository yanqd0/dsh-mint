import { describe, expect, it } from 'vitest';

import { NS, ZH, createTranslator, interpolate } from './copy.js';

describe('panel copy', () => {
  it('namespaces the dictionary under `mint`', () => {
    expect(NS).toBe('mint');
  });

  it('carries a non-empty Simplified Chinese string for every key', () => {
    for (const [key, value] of Object.entries(ZH)) {
      expect(key.length, 'a key cannot be empty').toBeGreaterThan(0);
      expect(value.length, `copy for ${key} cannot be empty`).toBeGreaterThan(0);
    }
  });

  it('interpolates named placeholders, leaving unknown ones written', () => {
    expect(interpolate('第 {page}/{pages} 页', { page: 2, pages: 5 })).toBe('第 2/5 页');
    expect(interpolate('第 {page} 页')).toBe('第 {page} 页');
    expect(interpolate('{a} {b}', { a: 'x' })).toBe('x {b}');
  });

  it('passes a translated key through and fills params on the fallback path', () => {
    const bound = (key: string): string => (key === 'view.issues' ? 'Issues' : key);
    const t = createTranslator(bound);
    expect(t('view.issues')).toBe('Issues');

    // A locale that does not carry the namespace shows the key; the wrapper
    // answers Chinese instead, params included.
    expect(t('state.empty')).toBe(ZH['state.empty']);
    expect(t('pager.summary', { page: 1, pages: 3, total: 12 })).toBe('第 1/3 页，共 12 条');
  });

  it('forwards params to the bound translator rather than only to the fallback', () => {
    const seen: Array<Record<string, string | number> | undefined> = [];
    const t = createTranslator((_key, params) => {
      seen.push(params);
      return 'ok';
    });
    expect(t('pager.summary', { page: 2 })).toBe('ok');
    expect(seen[0]).toEqual({ page: 2 });
  });
});
