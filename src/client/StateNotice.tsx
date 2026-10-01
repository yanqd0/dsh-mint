/**
 * The loading / empty / failed notices every mint view shares.
 *
 * One component means a broken mint entry, a dead session, and an empty project
 * look like three states of the same panel rather than three different panels.
 */
import type { ReactElement } from 'react';

import { BODY, BUTTON, NOTE, PROSE } from './styles.js';
import type { CopyTranslate } from './copy.js';

export interface StateNoticeProps {
  copy: CopyTranslate;
  state: 'loading' | 'empty' | 'failed';
  /** Failure text as the route reported it. */
  message?: string | undefined;
  /** mint's own stderr, shown verbatim when it carried something actionable. */
  stderr?: string | undefined;
  /** Offered for `failed` and `empty`: load again. */
  onRetry?: (() => void) | undefined;
}

/**
 * Render one notice.
 *
 * @param props - the state, its text, and the retry hook.
 */
export function StateNotice({ copy, state, message, stderr, onRetry }: StateNoticeProps): ReactElement {
  const text =
    state === 'loading'
      ? copy('state.loading')
      : state === 'empty'
        ? copy('state.empty')
        : (message ?? copy('state.error'));

  return (
    <div style={BODY}>
      <p style={NOTE}>{text}</p>
      {stderr !== undefined && <p style={PROSE}>{stderr}</p>}
      {state !== 'loading' && onRetry !== undefined && (
        <button type="button" style={{ ...BUTTON, marginTop: 8 }} onClick={onRetry}>
          {copy('state.retry')}
        </button>
      )}
    </div>
  );
}
