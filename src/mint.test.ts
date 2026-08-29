import { describe, expect, it } from 'vitest';

import { resolveMintEntry } from './mint.js';

describe('resolveMintEntry', () => {
  it('resolves mint-faa run-mint.js via node_modules', () => {
    const entry = resolveMintEntry();
    expect(entry).toContain('mint-faa');
    expect(entry).toMatch(/run-mint\.js$/);
  });
});
