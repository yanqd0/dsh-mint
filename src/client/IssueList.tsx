/**
 * issue 列表：筛选栏、分页与每行一条 issue。行用按钮而非 `div`，
 * 这样键盘可达且可操作，无需另造 roving focus 模型。
 */
import type { ReactElement } from 'react';

import type { IssueItem, MintListPayload, MintMetaPayload } from '../shared/records.js';
import { IssueRow } from './Rows.js';
import { StateNotice } from './StateNotice.js';
import type { CopyTranslate } from './copy.js';
import type { LoadState } from './model.js';
import { BODY, BUTTON, FILTER_LABEL, INPUT, NOTE, TAB_ACTIVE, TOOLBAR } from './styles.js';

export interface IssueListProps {
  copy: CopyTranslate;
  state: LoadState<MintListPayload<IssueItem>>;
  meta: MintMetaPayload | undefined;
  /** 搜索框实时文本；由调用方防抖后才成为请求。 */
  search: string;
  allStates: boolean;
  onSearch: (next: string) => void;
  onAllStates: (next: boolean) => void;
  onRefresh: () => void;
  onPage: (next: number) => void;
  onSelect: (item: IssueItem) => void;
}

export function IssueList(props: IssueListProps): ReactElement {
  const {
    copy,
    state,
    meta,
    search,
    allStates,
    onSearch,
    onAllStates,
    onRefresh,
    onPage,
    onSelect,
  } = props;

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
        <label style={FILTER_LABEL}>
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
          <div
            style={{
              ...TOOLBAR,
              borderTop: '1px solid var(--dsw-alias-border-l1)',
              borderBottom: 'none',
            }}
          >
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
