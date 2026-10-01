import { describe, expect, it } from 'vitest';

import { pill } from './styles.js';

describe('panel styles', () => {
  // The tone is the only thing that varies, and it must reach a real theme token:
  // an invented token renders as an unstyled pill rather than failing loudly.
  it('colors a status pill from the theme state tokens', () => {
    for (const tone of ['success', 'warn', 'idle', 'error'] as const) {
      const style = pill(tone);
      expect(style.color).toBe(`var(--dsw-alias-state-${tone}-primary)`);
      expect(style.border).toContain(`var(--dsw-alias-state-${tone}-primary)`);
    }
  });
});
