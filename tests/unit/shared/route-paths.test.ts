import { describe, expect, it } from 'vitest';

import { ROUTES } from '../../../src/client/api.js';
import { ROUTE_NAMES, ROUTE_PREFIX, routePath } from '../../../src/shared/route-paths.js';

/**
 * The route space has two readers — the host's prefix handler and the browser
 * half's `fetch`es — so the only thing worth asserting is that both derive from
 * one declaration (#104).
 */
describe('route paths', () => {
  it('builds every route under the prefix, with no trailing slash', () => {
    expect(ROUTE_PREFIX.endsWith('/')).toBe(false);
    for (const name of ROUTE_NAMES) {
      expect(routePath(name)).toBe(`${ROUTE_PREFIX}/${name}`);
      // The host's prefix-match rule: exactly the prefix or a child path.
      const pathname = routePath(name);
      expect(pathname === ROUTE_PREFIX || pathname.startsWith(`${ROUTE_PREFIX}/`)).toBe(true);
    }
    // A neighbouring path is not ours.
    expect('/dsh-mint-other'.startsWith(`${ROUTE_PREFIX}/`)).toBe(false);
  });

  it('keeps the browser half on exactly the host routes (#104)', () => {
    expect(Object.values(ROUTES)).toEqual(ROUTE_NAMES.map((name) => routePath(name)));
  });
});
