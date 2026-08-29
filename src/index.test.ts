import { describe, expect, it } from 'vitest';

import { version } from './index.js';

describe('dsh-mint', () => {
  it('exports a version string', () => {
    expect(version).toBe('0.1.0-alpha.0');
  });
});
