import { describe, expect, it } from 'vitest';

import {
  DAG_NODE_LABEL,
  DAG_NODE_METRICS,
  DAG_RUNNING_CLASS,
  LIVE_TIME_COLOR,
  LIVE_TOKENS_COLOR,
  dagLiveTimeStyle,
  dagLiveTokensStyle,
  dagNodeStyle,
  labelBadge,
  pill,
  placementChip,
} from './styles.js';

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

describe('DAG node styles', () => {
  // The tone reaches a real theme token, exactly like the status pill: an
  // invented token would render every node as an unstyled box.
  it('tints and strokes a node from the theme state tokens', () => {
    for (const tone of ['warn', 'success', 'error'] as const) {
      const style = dagNodeStyle(tone);
      expect(style.stroke).toBe(`var(--dsw-alias-state-${tone}-primary)`);
      expect(style.fill).toBe(
        `color-mix(in srgb, var(--dsw-alias-state-${tone}-primary) 12%, var(--dsw-alias-bg-layer-1))`
      );
    }
  });

  // The class is the only hook the injected keyframes have; renaming it here
  // without renaming the `<style>` block would silently stop the pulse.
  it('names the pulsing node class once', () => {
    expect(DAG_RUNNING_CLASS).toBe('dsh-mint-dag-running');
  });
});

describe('live metric styles', () => {
  // A measured token count is money in this palette, so the line spends the
  // theme's warning tone; an invented token would render as an unstyled line.
  it('puts the measured token count on a real theme token', () => {
    expect(LIVE_TOKENS_COLOR).toBe('var(--dsw-alias-state-warn-primary)');
    expect(dagLiveTokensStyle()).toEqual({ fill: 'var(--dsw-alias-state-warn-primary)' });
  });

  // This theme carries no purple alias token, so the time color is a literal by
  // design; pinning it here is what keeps the concession from drifting.
  it('pins the measured time color to its controlled literal', () => {
    expect(LIVE_TIME_COLOR).toBe('#8b76f6');
    expect(dagLiveTimeStyle()).toEqual({ fill: '#8b76f6' });
  });

  // The two lines share the node box: the metrics line is the smaller of them.
  it('sets the metrics line below the node label', () => {
    expect(DAG_NODE_METRICS.fontSize).toBe(9);
    expect(DAG_NODE_METRICS.fontFamily).toBe('inherit');
    expect(Number(DAG_NODE_METRICS.fontSize)).toBeLessThan(Number(DAG_NODE_LABEL.fontSize));
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
