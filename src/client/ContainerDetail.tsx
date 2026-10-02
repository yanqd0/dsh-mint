/**
 * One plan or milestone in full, with the issues it holds.
 *
 * The children are links into the issue view: the route reads an issue in full
 * from `show --json`, so following one never depends on the list that happened to
 * be on screen.
 */
import type { ReactElement } from 'react';

import type { ContainerDetail } from '../records.js';
import { BodyView } from './Body.js';
import { StateNotice } from './StateNotice.js';
import type { CopyTranslate } from './copy.js';
import { containerChildLine, statusTone } from './model.js';
import type { LoadState } from './model.js';
import { BODY, BUTTON, META, NOTE, ROW, TOOLBAR, pill } from './styles.js';

export interface ContainerDetailProps {
  copy: CopyTranslate;
  /** Which kind the payload holds, for the heading. */
  kind: 'plan' | 'milestone';
  state: LoadState<ContainerDetail>;
  onBack: () => void;
  onRefresh: () => void;
  onOpenIssue: (id: number) => void;
}

/**
 * Render the container.
 *
 * @param props - copy, kind, loaded state, and the navigation callbacks.
 */
export function ContainerDetail({
  copy,
  kind,
  state,
  onBack,
  onRefresh,
  onOpenIssue,
}: ContainerDetailProps): ReactElement {
  const back = (
    <div style={TOOLBAR}>
      <button type="button" style={BUTTON} onClick={onBack}>
        {copy('detail.back')}
      </button>
      <button type="button" style={BUTTON} onClick={onRefresh}>
        {copy('panel.refresh')}
      </button>
    </div>
  );

  if (state.status !== 'ready') {
    return (
      <>
        {back}
        <StateNotice
          copy={copy}
          state={state.status === 'loading' ? 'loading' : 'failed'}
          message={state.status === 'failed' ? state.message : undefined}
          stderr={state.status === 'failed' ? state.stderr : undefined}
          onRetry={onRefresh}
        />
      </>
    );
  }

  const item = state.value;
  const heading = `#${String(item.id)} ${item.title}`;

  return (
    <>
      {back}
      <div style={BODY}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>{heading}</div>
        <div style={{ ...META, marginTop: 6 }}>
          <span>{copy(kind === 'plan' ? 'container.plan' : 'container.milestone')}</span>
          <span style={pill(statusTone(item.status))}>{item.status}</span>
          <span>{`${copy('field.version')} ${item.version}`}</span>
          {item.milestone_id !== null && (
            <span>{`${copy('field.milestone')} #${String(item.milestone_id)}`}</span>
          )}
          <span>{`${copy('field.updated')} ${item.updated_at}`}</span>
        </div>
        <BodyView copy={copy} body={item.body} />

        <div style={{ ...NOTE, marginTop: 12 }}>{copy('field.issues')}</div>
        {item.issues.length === 0 ? (
          <p style={NOTE}>{copy('state.empty')}</p>
        ) : (
          item.issues.map((child) => (
            <button
              key={child.id}
              type="button"
              style={{ ...ROW, borderBottom: '1px solid var(--dsw-alias-border-l1)' }}
              onClick={() => {
                onOpenIssue(child.id);
              }}
            >
              <span>{containerChildLine(child)}</span>
              <span style={NOTE}>{child.status}</span>
            </button>
          ))
        )}
      </div>
    </>
  );
}
