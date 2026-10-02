import { describe, expect, it } from 'vitest';

import { labelBadge, pill, placementChip } from './styles.js';

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

describe('label badges', () => {
  it('tints the badge from the recorded color, like the shell Tag tones', () => {
    const badge = labelBadge('#bbdd3c');
    expect(badge.color).toBe('#bbdd3c');
    expect(badge.background).toBe('color-mix(in srgb, #bbdd3c 10%, transparent)');
    expect(badge.borderColor).toBe('color-mix(in srgb, #bbdd3c 45%, transparent)');
    expect(badge.borderRadius).toBe(999);
  });

  // The color arrives from the database through the CLI: an unrecognized value
  // must never reach CSS, and must still render as a readable chip.
  it('falls back to a neutral chip for a color it cannot trust', () => {
    for (const color of ['', 'red', '#12345', 'rgb(1,2,3)', '#bbdd3c; color: red']) {
      const badge = labelBadge(color);
      expect(badge.color).toBe('var(--dsw-alias-label-tertiary)');
      expect(badge.borderColor).toBe('var(--dsw-alias-border-l4)');
      expect(badge.background).toBe('var(--dsw-alias-bg-layer-2)');
    }
  });
});
