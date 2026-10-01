/**
 * The mint tab's body.
 *
 * Owns the tab's chrome (the three read-only views) and, for the issue view, the
 * request state: what to read, when, and how a failure is presented. Every
 * decision it makes is delegated to `model.ts`, so this file stays a wiring
 * layer over values another test can check in Node.
 *
 * The list read is aborted and re-run when the filters change, when the tab's
 * refresh command fires, and when the tab record itself goes away (`tab.signal`).
 */
import { useEffect, useState } from 'react';
import type { CSSProperties, ReactElement } from 'react';

import type { IssueItem, MintBodyPayload, MintListPayload } from '../records.js';
import { IssueDetail } from './IssueDetail.js';
import { IssueList } from './IssueList.js';
import { clampPage, toLoadState } from './model.js';
import type { LoadState } from './model.js';
import { HEADER, NOTE, SHELL, TAB, TAB_ACTIVE } from './styles.js';
import type { MintBodyProps, TabInfoLike } from './types.js';

/** The three read-only views, in tab order. */
const VIEW_KEYS = ['view.issues', 'view.plans', 'view.milestones'] as const;

type ViewKey = (typeof VIEW_KEYS)[number];

/** How many issues one page holds; mint accepts up to 100. */
const PAGE_SIZE = 20;

/** How long the search box settles before it becomes a request. */
const SEARCH_DEBOUNCE_MS = 300;

/** The seat's hook; a stable no-op keeps the call unconditional in lean harnesses. */
const NO_TAB_INFO = (): TabInfoLike | undefined => undefined;

const PLACEHOLDER: CSSProperties = { padding: 10 };

/**
 * Render the panel.
 *
 * @param props - session identity, copy, transport, and the seat's tab hook.
 */
export function MintBody(props: MintBodyProps): ReactElement {
  const { api, copy, useTabInfo = NO_TAB_INFO } = props;
  const info = useTabInfo();
  const signal = info?.tab.signal;
  const actions = info?.tab.actions;

  const [view, setView] = useState<ViewKey>('view.issues');
  const [allStates, setAllStates] = useState(false);
  const [draft, setDraft] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [reload, setReload] = useState(0);
  const [list, setList] = useState<LoadState<MintListPayload<IssueItem>>>({ status: 'loading' });
  const [selected, setSelected] = useState<IssueItem | undefined>(undefined);
  const [body, setBody] = useState<LoadState<MintBodyPayload> | undefined>(undefined);

  // Settle the search box before it becomes a request.
  useEffect(() => {
    if (draft === search) return;
    const timer = setTimeout(() => {
      setSearch(draft);
      setPage(1);
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [draft, search]);

  // Read the issue page whenever a filter, the page, or the refresh counter moves.
  useEffect(() => {
    if (view !== 'view.issues') return;
    if (signal?.aborted === true) return;
    const controller = new AbortController();
    const abort = (): void => {
      controller.abort();
    };
    signal?.addEventListener('abort', abort);
    setList({ status: 'loading' });
    void api
      .issues(
        {
          ...(allStates ? { allStates: '1' } : {}),
          ...(search === '' ? {} : { search }),
          page: String(page),
          pageSize: String(PAGE_SIZE),
        },
        controller.signal
      )
      .then((response) => {
        setList(toLoadState(response));
      });
    return () => {
      signal?.removeEventListener('abort', abort);
      controller.abort();
    };
  }, [api, view, allStates, search, page, reload, signal]);

  // A filter change can leave the caller on a page that no longer exists.
  useEffect(() => {
    if (list.status !== 'ready') return;
    const next = clampPage(page, list.value.pages);
    if (next !== page) setPage(next);
  }, [list, page]);

  // The tab's own refresh command (toolbar, shortcut, context menu).
  useEffect(() => {
    if (actions === undefined) return;
    return actions.bindCommands({
      refresh: () => {
        setReload((count) => count + 1);
      },
    });
  }, [actions]);

  // The body of the open issue, read separately because `list --json` omits it.
  useEffect(() => {
    if (selected === undefined) {
      setBody(undefined);
      return;
    }
    const controller = new AbortController();
    setBody({ status: 'loading' });
    void api.issueBody(selected.id, controller.signal).then((response) => {
      setBody(toLoadState(response));
    });
    return () => {
      controller.abort();
    };
  }, [api, selected]);

  const refresh = (): void => {
    setReload((count) => count + 1);
  };

  return (
    <div style={SHELL}>
      <div style={HEADER} role="tablist" aria-label={copy('type.label')}>
        {VIEW_KEYS.map((key) => {
          const selectedView = key === view;
          return (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={selectedView}
              onClick={() => {
                setView(key);
              }}
              style={selectedView ? TAB_ACTIVE : TAB}
            >
              {copy(key)}
            </button>
          );
        })}
      </div>
      {view === 'view.issues' ? (
        selected === undefined ? (
          <IssueList
            copy={copy}
            state={list}
            search={draft}
            allStates={allStates}
            onSearch={setDraft}
            onAllStates={(next) => {
              setAllStates(next);
              setPage(1);
            }}
            onRefresh={refresh}
            onPage={setPage}
            onSelect={setSelected}
          />
        ) : (
          <IssueDetail copy={copy} item={selected} body={body} onBack={() => setSelected(undefined)} />
        )
      ) : (
        <div style={PLACEHOLDER}>
          <p style={NOTE}>{copy('state.skeleton')}</p>
        </div>
      )}
    </div>
  );
}
