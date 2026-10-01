/**
 * The mint tab's body.
 *
 * #11 lands the shell: the three read-only views, the panel chrome, and the
 * state machine every view will share. The lists and details themselves arrive
 * with #12 (issue) and #79 (plan / milestone); until then each view states what
 * it is, so the tab is never a blank rectangle.
 *
 * Styling uses the theme's `--dsw-*` tokens only, so the panel inherits light and
 * dark themes instead of carrying its own palette.
 */
import { useState } from 'react';
import type { CSSProperties, ReactElement } from 'react';

import type { MintBodyProps } from './types.js';

/** The three read-only views, in tab order. */
const VIEW_KEYS = ['view.issues', 'view.plans', 'view.milestones'] as const;

type ViewKey = (typeof VIEW_KEYS)[number];

const SHELL: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  height: '100%',
  minHeight: 0,
  color: 'var(--dsw-alias-label-primary)',
};

const HEADER: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 2,
  flex: 'none',
  padding: '6px 8px',
  borderBottom: '1px solid var(--dsw-alias-border-l1)',
};

const TAB: CSSProperties = {
  appearance: 'none',
  border: 'none',
  background: 'transparent',
  color: 'var(--dsw-alias-label-secondary)',
  font: 'inherit',
  padding: '4px 8px',
  borderRadius: 6,
  cursor: 'pointer',
};

const TAB_ACTIVE: CSSProperties = {
  ...TAB,
  background: 'var(--dsw-alias-bg-layer-1)',
  color: 'var(--dsw-alias-label-primary)',
};

const BODY: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflow: 'auto',
  padding: 10,
};

const NOTE: CSSProperties = {
  margin: 0,
  color: 'var(--dsw-alias-label-secondary)',
  fontSize: 12,
};

/**
 * Render the panel.
 *
 * @param props - the copy seat; the transport and session identity arrive the
 *   same way but are only needed by the views (#12 / #79).
 */
export function MintBody({ t }: MintBodyProps): ReactElement {
  const [view, setView] = useState<ViewKey>('view.issues');

  return (
    <div style={SHELL}>
      <div style={HEADER} role="tablist" aria-label={t('type.label')}>
        {VIEW_KEYS.map((key) => {
          const selected = key === view;
          return (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => {
                setView(key);
              }}
              style={selected ? TAB_ACTIVE : TAB}
            >
              {t(key)}
            </button>
          );
        })}
      </div>
      <div style={BODY}>
        <p style={NOTE}>{t('state.skeleton')}</p>
      </div>
    </div>
  );
}
