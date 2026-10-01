/**
 * The plan and milestone list.
 *
 * One component serves both kinds: mint's containers differ in what their rows
 * say, not in how a list behaves, so the caller supplies the row projection and
 * this file owns the chrome, the pagination, and the states.
 */
import type { ReactElement } from 'react';

import type { MintListPayload } from '../records.js';
import { StateNotice } from './StateNotice.js';
import type { CopyTranslate } from './copy.js';
import type { ContainerRow, LoadState } from './model.js';
import { BODY, BUTTON, NOTE, ROW, TOOLBAR } from './styles.js';

export interface ContainerListProps<T> {
  copy: CopyTranslate;
  /** Project one CLI record onto a row. */
  row: (item: T) => ContainerRow;
  state: LoadState<MintListPayload<T>>;
  onRefresh: () => void;
  onPage: (next: number) => void;
  onSelect: (item: T) => void;
}

/**
 * Render the list.
 *
 * @param props - copy, the row projection, loaded state, and the callbacks.
 */
export function ContainerList<T>({
  copy,
  row,
  state,
  onRefresh,
  onPage,
  onSelect,
}: ContainerListProps<T>): ReactElement {
  if (state.status !== 'ready') {
    return (
      <StateNotice
        copy={copy}
        state={state.status === 'loading' ? 'loading' : 'failed'}
        message={state.status === 'failed' ? state.message : undefined}
        stderr={state.status === 'failed' ? state.stderr : undefined}
        onRetry={onRefresh}
      />
    );
  }

  const { items, page, pages, total, warnings } = state.value;

  return (
    <>
      <div style={TOOLBAR}>
        <span style={{ ...NOTE, flex: 1 }}>{copy('pager.summary', { page, pages, total })}</span>
        <button type="button" style={BUTTON} onClick={onRefresh}>
          {copy('panel.refresh')}
        </button>
      </div>
      {warnings?.map((warning) => (
        <p key={warning} style={{ ...NOTE, padding: '6px 10px 0' }}>
          {warning}
        </p>
      ))}
      {items.length === 0 ? (
        <StateNotice copy={copy} state="empty" onRetry={onRefresh} />
      ) : (
        <>
          <div style={BODY}>
            {items.map((item) => {
              const line = row(item);
              return (
                <button
                  key={line.id}
                  type="button"
                  style={ROW}
                  onClick={() => {
                    onSelect(item);
                  }}
                >
                  <span>{`#${String(line.id)} ${line.title}`}</span>
                  <span style={NOTE}>{line.meta}</span>
                </button>
              );
            })}
          </div>
          <div style={{ ...TOOLBAR, borderTop: '1px solid var(--dsw-alias-border-l1)', borderBottom: 'none' }}>
            <button
              type="button"
              style={BUTTON}
              disabled={page <= 1}
              onClick={() => {
                onPage(page - 1);
              }}
            >
              {copy('pager.prev')}
            </button>
            <span style={NOTE}>{`${String(page)}/${String(pages)}`}</span>
            <button
              type="button"
              style={BUTTON}
              disabled={page >= pages}
              onClick={() => {
                onPage(page + 1);
              }}
            >
              {copy('pager.next')}
            </button>
          </div>
        </>
      )}
    </>
  );
}
