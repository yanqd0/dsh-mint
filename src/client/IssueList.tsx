/**
 * The issue list: filter bar, pagination, and one row per issue.
 *
 * The rows are buttons (not `div`s) so the list is reachable and operable from
 * the keyboard without inventing a roving-focus model.
 */
import type { ReactElement } from 'react';

import type { IssueItem, MintListPayload, MintMetaPayload } from '../records.js';
import { IssueRow } from './Rows.js';
import { StateNotice } from './StateNotice.js';
import type { CopyTranslate } from './copy.js';
import type { LoadState } from './model.js';
import { BODY, BUTTON, INPUT, NOTE, TAB_ACTIVE, TOOLBAR } from './styles.js';

export interface IssueListProps {
  copy: CopyTranslate;
  state: LoadState<MintListPayload<IssueItem>>;
  /** The lookup tables rows read for placement; absent until they load. */
  meta: MintMetaPayload | undefined;
  /** The search box's live text (the caller debounces it into a request). */
  search: string;
  /** Whether the hide-settled default is off. */
  allStates: boolean;
  onSearch: (next: string) => void;
  onAllStates: (next: boolean) => void;
  onRefresh: () => void;
  onPage: (next: number) => void;
  onSelect: (item: IssueItem) => void;
}

/**
 * Render the list.
 *
 * @param props - copy, loaded state, filters, and the callbacks that change them.
 */
export function IssueList(props: IssueListProps): ReactElement {
  const { copy, state, meta, search, allStates, onSearch, onAllStates, onRefresh, onPage, onSelect } =
    props;

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
        <input
          style={INPUT}
          type="search"
          value={search}
          placeholder={copy('panel.search')}
          aria-label={copy('panel.search')}
          onChange={(event) => {
            onSearch(event.target.value);
          }}
        />
        <label style={{ ...NOTE, display: 'flex', alignItems: 'center', gap: 4 }}>
          <input
            type="checkbox"
            checked={allStates}
            onChange={(event) => {
              onAllStates(event.target.checked);
            }}
          />
          {copy('panel.allStates')}
        </label>
        <button type="button" style={BUTTON} onClick={onRefresh}>
          {copy('panel.refresh')}
        </button>
      </div>
      {warnings !== undefined &&
        warnings.map((warning) => (
          <p key={warning} style={{ ...NOTE, padding: '6px 10px 0' }}>
            {warning}
          </p>
        ))}
      {items.length === 0 ? (
        <StateNotice copy={copy} state="empty" onRetry={onRefresh} />
      ) : (
        <>
          <div style={BODY}>
            {items.map((item) => (
              <IssueRow key={item.id} copy={copy} item={item} meta={meta} onSelect={onSelect} />
            ))}
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
            <span style={NOTE}>{copy('pager.summary', { page, pages, total })}</span>
            <button
              type="button"
              style={page >= pages ? { ...TAB_ACTIVE, opacity: 0.5 } : BUTTON}
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
