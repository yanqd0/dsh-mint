/**
 * Shared style objects for the mint panel.
 *
 * Only theme tokens (`--dsw-*`) are used, so the panel inherits the page's light
 * and dark palettes instead of carrying its own. Objects are shared by reference
 * between views, which is what keeps the whole panel consistent without a CSS
 * pipeline in the client bundle.
 */
import type { CSSProperties } from 'react';

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

export const ROW_ACTIVE: CSSProperties = {
  ...ROW,
  background: 'var(--dsw-alias-bg-layer-1)',
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
