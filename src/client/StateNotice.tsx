/**
 * 所有 mint 视图共用的 loading / empty / failed 提示：共用一个组件，
 * 让 mint 入口损坏、会话失效与空项目呈现为同一面板的三种状态，
 * 而不是三个互不相同的面板。
 */
import type { ReactElement } from 'react';

import { BODY, BUTTON, NOTE, PROSE } from './styles.js';
import type { CopyTranslate } from './copy.js';
import { routeErrorKey } from './model.js';

export interface StateNoticeProps {
  copy: CopyTranslate;
  state: 'loading' | 'empty' | 'failed';
  message?: string | undefined;
  /** mint 自身 stderr：属诊断信息，原样展示。 */
  stderr?: string | undefined;
  onRetry?: (() => void) | undefined;
}

export function StateNotice({ copy, state, message, stderr, onRetry }: StateNoticeProps): ReactElement {
  // A failure the panel can name in its own words is localized; any other text
  // (mint's stderr, a shape warning) is diagnostic and shows verbatim.
  const key = message === undefined ? undefined : routeErrorKey(message);
  const text =
    state === 'loading'
      ? copy('state.loading')
      : state === 'empty'
        ? copy('state.empty')
        : key === undefined
          ? (message ?? copy('state.error'))
          : copy(key);

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
