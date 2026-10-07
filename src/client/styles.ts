/**
 * Shared style objects for the mint panel.
 *
 * Only theme tokens (`--dsw-*`) are used, so the panel inherits the page's light
 * and dark palettes instead of carrying its own. Objects are shared by reference
 * between views, which is what keeps the whole panel consistent without a CSS
 * pipeline in the client bundle.
 */
import type { CSSProperties } from 'react';

import type { DagTone } from './dag-model.js';
import type { StatusTone } from './model.js';

export const SHELL: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  height: '100%',
  minHeight: 0,
  color: 'var(--dsw-alias-label-primary)',
};

export const HEADER: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 2,
  flex: 'none',
  padding: '6px 8px',
  borderBottom: '1px solid var(--dsw-alias-border-l1)',
};

export const TAB: CSSProperties = {
  appearance: 'none',
  border: 'none',
  background: 'transparent',
  color: 'var(--dsw-alias-label-secondary)',
  font: 'inherit',
  padding: '4px 8px',
  borderRadius: 6,
  cursor: 'pointer',
};

export const TAB_ACTIVE: CSSProperties = {
  ...TAB,
  background: 'var(--dsw-alias-bg-layer-1)',
  color: 'var(--dsw-alias-label-primary)',
};

export const TOOLBAR: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  flex: 'none',
  padding: '6px 10px',
  borderBottom: '1px solid var(--dsw-alias-border-l1)',
};

export const BUTTON: CSSProperties = {
  ...TAB,
  border: '1px solid var(--dsw-alias-border-l1)',
  color: 'var(--dsw-alias-label-primary)',
};

export const INPUT: CSSProperties = {
  flex: 1,
  minWidth: 0,
  font: 'inherit',
  color: 'var(--dsw-alias-label-primary)',
  background: 'var(--dsw-alias-bg-layer-1)',
  border: '1px solid var(--dsw-alias-border-l1)',
  borderRadius: 6,
  padding: '3px 6px',
};

export const BODY: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflow: 'auto',
  padding: 10,
};

export const NOTE: CSSProperties = {
  margin: 0,
  color: 'var(--dsw-alias-label-secondary)',
  fontSize: 12,
};

/** The label that wraps one filter checkbox, so both lists sit the same way. */
export const FILTER_LABEL: CSSProperties = {
  ...NOTE,
  display: 'flex',
  alignItems: 'center',
  gap: 4,
};

export const ROW: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  width: '100%',
  textAlign: 'left',
  font: 'inherit',
  color: 'inherit',
  background: 'transparent',
  border: 'none',
  borderBottom: '1px solid var(--dsw-alias-border-l1)',
  padding: '8px 4px',
  cursor: 'pointer',
};

export const META: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  flexWrap: 'wrap',
  color: 'var(--dsw-alias-label-secondary)',
  fontSize: 11,
};

export const PROSE: CSSProperties = {
  margin: '8px 0 0',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 12,
  lineHeight: 1.5,
};

/** The pill that carries a mint lifecycle state. */
export function pill(tone: StatusTone): CSSProperties {
  return {
    color: `var(--dsw-alias-state-${tone}-primary)`,
    border: `1px solid var(--dsw-alias-state-${tone}-primary)`,
    borderRadius: 999,
    padding: '0 6px',
    fontSize: 10,
    lineHeight: '16px',
  };
}

/** The characters a label color may consist of before it is trusted in CSS. */
const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/**
 * The badge that carries one label.
 *
 * Geometry mirrors the shell's `Tag` (fixed capsule, only the palette varies),
 * but the palette is the color mint recorded for that label rather than a theme
 * tone. The value comes out of the database through the CLI, so it is checked
 * here: an unrecognized color falls back to a neutral chip instead of being
 * interpolated into CSS.
 *
 * @param color - the label's recorded `#rgb` / `#rrggbb` value, or anything else.
 */
export function labelBadge(color: string): CSSProperties {
  const base: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    borderRadius: 999,
    borderWidth: 0.5,
    borderStyle: 'solid',
    padding: '1px 8px',
    fontSize: 11,
    lineHeight: '17px',
    fontWeight: 500,
    whiteSpace: 'nowrap',
  };
  if (!HEX_COLOR.test(color)) {
    return {
      ...base,
      color: 'var(--dsw-alias-label-tertiary)',
      borderColor: 'var(--dsw-alias-border-l4)',
      background: 'var(--dsw-alias-bg-layer-2)',
    };
  }
  return {
    ...base,
    color,
    borderColor: `color-mix(in srgb, ${color} 45%, transparent)`,
    background: `color-mix(in srgb, ${color} 10%, transparent)`,
  };
}

/** The line a row's label badges live on. */
export const LABELS: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: 4,
};

/** Which parent a row's chip names. */
export type PlacementKind = 'plan' | 'direct' | 'viaPlan';

/**
 * The chip that carries one parent reference.
 *
 * A plan reads as an id in a quiet capsule; a milestone keeps the primary tone
 * when it is the issue's own and drops to a dashed secondary one when it is
 * reached through the plan — the difference is the point of showing both.
 *
 * @param kind - which parent the chip stands for.
 */
export function placementChip(kind: PlacementKind): CSSProperties {
  const base: CSSProperties = {
    borderRadius: 999,
    borderWidth: 1,
    borderStyle: 'solid',
    padding: '0 6px',
    fontSize: 10,
    lineHeight: '16px',
  };
  switch (kind) {
    case 'plan':
      return {
        ...base,
        color: 'var(--dsw-alias-label-secondary)',
        borderColor: 'var(--dsw-alias-border-l1)',
      };
    case 'direct':
      return {
        ...base,
        color: 'var(--dsw-alias-label-primary)',
        borderColor: 'var(--dsw-alias-label-primary)',
      };
    case 'viaPlan':
      return {
        ...base,
        color: 'var(--dsw-alias-label-secondary)',
        borderColor: 'var(--dsw-alias-border-l2)',
        borderStyle: 'dashed',
      };
  }
}

/**
 * The DAG pane's frame. Same column shape as {@link SHELL}, minus the header:
 * the pane is one scrollable canvas and one summary line.
 */
export const DAG_SHELL: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  height: '100%',
  minHeight: 0,
  color: 'var(--dsw-alias-label-primary)',
};

/**
 * The scrolling viewport around the SVG.
 *
 * `position: relative` is what anchors the hover tooltip, and it must live on
 * the canvas rather than on a node: an absolutely positioned tooltip inside an
 * `<svg>` is not something every engine lays out the same way.
 */
export const DAG_CANVAS: CSSProperties = {
  position: 'relative',
  flex: 1,
  minHeight: 0,
  overflow: 'auto',
  padding: 8,
};

/**
 * The hover tooltip: the node's full text next to its box.
 *
 * `maxHeight` plus `overflow: auto` is the contract from the spec — a node's
 * `note` is a subagent's conclusion quoted verbatim, and it can be long; the
 * tooltip scrolls instead of stretching past the pane.
 */
export const DAG_TOOLTIP: CSSProperties = {
  position: 'absolute',
  zIndex: 1,
  maxWidth: 320,
  maxHeight: 240,
  overflow: 'auto',
  padding: '6px 8px',
  borderRadius: 6,
  border: '1px solid var(--dsw-alias-border-l1)',
  background: 'var(--dsw-alias-bg-layer-2)',
  color: 'var(--dsw-alias-label-primary)',
  fontSize: 12,
  lineHeight: 1.5,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  pointerEvents: 'none',
};

/** The class a pulsing node carries; its keyframes live in the body's `<style>`. */
export const DAG_RUNNING_CLASS = 'dsh-mint-dag-running';

/**
 * One node box, tinted by its tone.
 *
 * The fill is a mix of the tone into the panel's own layer, so a node keeps the
 * page's light/dark surface instead of becoming a flat swatch; the stroke is the
 * tone at full strength, which is what makes `running` read as brighter than
 * `done`.
 *
 * @param tone - the node's theme state tone.
 */
export function dagNodeStyle(tone: DagTone): CSSProperties {
  const token = `var(--dsw-alias-state-${tone}-primary)`;
  return {
    fill: `color-mix(in srgb, ${token} 12%, var(--dsw-alias-bg-layer-1))`,
    stroke: token,
    strokeWidth: 1.5,
  };
}

/** The node label: the SVG text an ellipsis-free six-code-point label sits in. */
export const DAG_NODE_LABEL: CSSProperties = {
  fill: 'var(--dsw-alias-label-primary)',
  fontSize: 12,
  fontFamily: 'inherit',
};

/** One line of the tooltip: technical fields are secondary to the prose. */
export const DAG_TOOLTIP_META: CSSProperties = {
  color: 'var(--dsw-alias-label-secondary)',
  fontSize: 11,
};
