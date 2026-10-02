import { describe, expect, it } from 'vitest';

import { pill, placementChip } from './styles.js';

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

  // The whole point of the pair is that a direct milestone looks different from
  // one reached through the plan, so the two must differ on a theme token axis.
  it('separates a direct milestone chip from a via-plan one', () => {
    const direct = placementChip('direct');
    const viaPlan = placementChip('viaPlan');
    expect(direct.color).toBe('var(--dsw-alias-label-primary)');
    expect(viaPlan.color).toBe('var(--dsw-alias-label-secondary)');
    expect(direct.borderStyle).toBe('solid');
    expect(viaPlan.borderStyle).toBe('dashed');
    expect(direct).not.toEqual(viaPlan);
  });

  it('draws a plan chip quietly, from real theme tokens', () => {
    const plan = placementChip('plan');
    expect(plan.color).toBe('var(--dsw-alias-label-secondary)');
    expect(plan.borderColor).toBe('var(--dsw-alias-border-l1)');
    expect(plan.borderRadius).toBe(999);
  });
});
