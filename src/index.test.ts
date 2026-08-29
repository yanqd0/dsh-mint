import { describe, expect, it } from 'vitest';

import { apply, name } from './index.js';

describe('dsh-mint plugin', () => {
  it('exposes the plugin name', () => {
    expect(name).toBe('dsh-mint');
  });

  it('provides a host-face apply function', () => {
    expect(typeof apply).toBe('function');
  });
});
