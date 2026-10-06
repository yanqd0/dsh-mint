/**
 * The mint tab's body.
 *
 * Owns the tab's chrome (the three read-only views) and the request state behind
 * each one: what to read, when, and how a failure is presented. Every decision it
 * makes is delegated to `model.ts`, so this file stays a wiring layer over values
 * another test can check in Node.
 *
 * Reads are aborted and re-run when their inputs change — filters, page, the
 * tab's refresh command, and the tab record's own lifetime (`tab.signal`).
 */
import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';

import type {
  ContainerDetail as ContainerDetailRecord,
  IssueDetail as IssueDetailRecord,
  IssueItem,
  MilestoneItem,
  MintIssuePayload,
  MintListPayload,
  MintMetaPayload,
  MintResponse,
  PlanItem,
} from '../records.js';
import { ContainerDetail } from './ContainerDetail.js';
import { ContainerList } from './ContainerList.js';
import { IssueDetail } from './IssueDetail.js';
import { IssueList } from './IssueList.js';
import { StateNotice } from './StateNotice.js';
import { activeContainer, clampPage, containerRow, detailContainer, embeddedIssuesQuery, toLoadState } from './model.js';
import type { ContainerTarget, LoadState } from './model.js';
import { HEADER, NOTE, SHELL, TAB, TAB_ACTIVE } from './styles.js';
import type { MintBodyProps, TabInfoLike } from './types.js';

/** The three read-only views, in tab order. */
const VIEW_KEYS = ['view.issues', 'view.plans', 'view.milestones'] as const;

type ViewKey = (typeof VIEW_KEYS)[number];

/** How many rows one page holds; mint accepts up to 100. */
const PAGE_SIZE = 20;

/** How long the search box settles before it becomes a request. */
const SEARCH_DEBOUNCE_MS = 300;

/** The seat's hook; a stable no-op keeps the call unconditional in lean harnesses. */
const NO_TAB_INFO = (): TabInfoLike | undefined => undefined;

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
  const [reload, setReload] = useState(0);

  // The lookup tables: plans, milestones, labels, and where each issue sits.
  // They do not depend on any filter or page, so one read serves every view and
  // only an explicit refresh replaces it.
  const [meta, setMeta] = useState<LoadState<MintMetaPayload>>({ status: 'loading' });

  // Issue view.
  const [issueAllStates, setIssueAllStates] = useState(false);
  const [draft, setDraft] = useState('');
  const [search, setSearch] = useState('');
  const [issuePage, setIssuePage] = useState(1);
  const [issues, setIssues] = useState<LoadState<MintListPayload<IssueItem>>>({ status: 'loading' });
  const [openIssueId, setOpenIssueId] = useState<number | undefined>(undefined);
  const [issue, setIssue] = useState<LoadState<MintIssuePayload> | undefined>(undefined);

  // Plan / milestone views. Both tabs read a container list and share one
  // filter: the settled-state default is a property of the list, not of the
  // table it reads.
  const kind: 'plan' | 'milestone' | undefined =
    view === 'view.plans' ? 'plan' : view === 'view.milestones' ? 'milestone' : undefined;
  const [containerAllStates, setContainerAllStates] = useState(false);
  const [containerPage, setContainerPage] = useState(1);
  const [containers, setContainers] = useState<
    LoadState<MintListPayload<PlanItem | MilestoneItem>>
  >({ status: 'loading' });
  // The open detail carries its kind: an id must never be read as another table.
  const [openContainer, setOpenContainer] = useState<ContainerTarget | undefined>(undefined);
  const [container, setContainer] = useState<LoadState<ContainerDetailRecord> | undefined>(
    undefined
  );
  // The detail view's own container, if the open target belongs to this tab.
  const active = kind === undefined ? undefined : activeContainer(openContainer, kind);
  const [embeddedIssues, setEmbeddedIssues] = useState<LoadState<MintListPayload<IssueItem>>>({
    status: 'loading',
  });

  // Settle the search box before it becomes a request.
  useEffect(() => {
    if (draft === search) return;
    const timer = setTimeout(() => {
      setSearch(draft);
      setIssuePage(1);
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [draft, search]);

  // Read the lookup tables once per mount and per explicit refresh.
  useEffect(() => {
    if (signal?.aborted === true) return;
    const controller = new AbortController();
    const abort = (): void => {
      controller.abort();
    };
    signal?.addEventListener('abort', abort);
    setMeta({ status: 'loading' });
    // `reload > 0` is the tab's explicit refresh (command or retry button): it
    // must bypass the host's placement memo, not merely re-read the tables.
    void api.meta(controller.signal, reload > 0).then((response) => {
      setMeta(toLoadState(response));
    });
    return () => {
      signal?.removeEventListener('abort', abort);
      controller.abort();
    };
  }, [api, reload, signal]);

  // Read the issue page whenever a filter, the page, or the refresh counter moves.
  useEffect(() => {
    if (view !== 'view.issues') return;
    if (signal?.aborted === true) return;
    const controller = new AbortController();
    const abort = (): void => {
      controller.abort();
    };
    signal?.addEventListener('abort', abort);
    setIssues({ status: 'loading' });
    void api
      .issues(
        {
          ...(issueAllStates ? { allStates: '1' } : {}),
          ...(search === '' ? {} : { search }),
          page: String(issuePage),
          pageSize: String(PAGE_SIZE),
        },
        controller.signal
      )
      .then((response) => {
        setIssues(toLoadState(response));
      });
    return () => {
      signal?.removeEventListener('abort', abort);
      controller.abort();
    };
  }, [api, view, issueAllStates, search, issuePage, reload, signal]);

  // Read one plan or milestone page when that view is showing.
  useEffect(() => {
    if (kind === undefined) return;
    if (signal?.aborted === true) return;
    const controller = new AbortController();
    const abort = (): void => {
      controller.abort();
    };
    signal?.addEventListener('abort', abort);
    setContainers({ status: 'loading' });
    const query = {
      page: String(containerPage),
      pageSize: String(PAGE_SIZE),
      ...(containerAllStates ? { allStates: '1' } : {}),
    };
    const request: Promise<MintResponse<MintListPayload<PlanItem | MilestoneItem>>> =
      kind === 'plan'
        ? api.plans(query, controller.signal)
        : api.milestones(query, controller.signal);
    void request.then((response) => {
      setContainers(toLoadState(response));
    });
    return () => {
      signal?.removeEventListener('abort', abort);
      controller.abort();
    };
  }, [api, kind, containerPage, containerAllStates, reload, signal]);

  // A filter change can leave the caller on a page that no longer exists.
  useEffect(() => {
    if (issues.status !== 'ready') return;
    const next = clampPage(issuePage, issues.value.pages);
    if (next !== issuePage) setIssuePage(next);
  }, [issues, issuePage]);

  useEffect(() => {
    if (containers.status !== 'ready') return;
    const next = clampPage(containerPage, containers.value.pages);
    if (next !== containerPage) setContainerPage(next);
  }, [containers, containerPage]);

  // The tab's own refresh command (toolbar, shortcut, context menu).
  useEffect(() => {
    if (actions === undefined) return;
    return actions.bindCommands({
      refresh: () => {
        setReload((count) => count + 1);
      },
    });
  }, [actions]);

  // One issue in full, including the body the list omits.
  useEffect(() => {
    if (openIssueId === undefined) {
      setIssue(undefined);
      return;
    }
    const controller = new AbortController();
    setIssue({ status: 'loading' });
    void api.issue(openIssueId, controller.signal).then((response) => {
      setIssue(toLoadState(response));
    });
    return () => {
      controller.abort();
    };
  }, [api, openIssueId, reload]);

  // One plan or milestone in full, with the issues it holds. The target names its
  // own table, so switching tabs never re-reads the same id in the other one.
  useEffect(() => {
    if (openContainer === undefined) {
      setContainer(undefined);
      return;
    }
    const controller = new AbortController();
    setContainer({ status: 'loading' });
    const request =
      openContainer.kind === 'plan'
        ? api.plan(openContainer.id, controller.signal)
        : api.milestone(openContainer.id, controller.signal);
    void request.then((response) => {
      const state = toLoadState(response);
      setContainer(state.status === 'ready' ? { status: 'ready', value: detailContainer(state.value) } : state);
    });
    return () => {
      controller.abort();
    };
  }, [api, openContainer, reload]);

  // Everything the open container holds, read with the embedded filter: the
  // outer list's own filters and page must not narrow what the detail shows.
  useEffect(() => {
    if (active === undefined) {
      setEmbeddedIssues({ status: 'loading' });
      return;
    }
    const controller = new AbortController();
    setEmbeddedIssues({ status: 'loading' });
    void api
      .issues(embeddedIssuesQuery(active.kind, active.id), controller.signal)
      .then((response) => {
        setEmbeddedIssues(toLoadState(response));
      });
    return () => {
      controller.abort();
    };
  }, [api, active, reload]);

  const refresh = (): void => {
    setReload((count) => count + 1);
  };

  /** The lookup tables when they are usable; rows degrade to what they carry. */
  const tables = meta.status === 'ready' ? meta.value : undefined;

  /** The issue view, list or detail. */
  const issueView = (): ReactElement => {
    if (openIssueId === undefined) {
      return (
        <IssueList
          copy={copy}
          state={issues}
          meta={tables}
          search={draft}
          allStates={issueAllStates}
          onSearch={setDraft}
          onAllStates={(next) => {
            setIssueAllStates(next);
            setIssuePage(1);
          }}
          onRefresh={refresh}
          onPage={setIssuePage}
          onSelect={(item) => {
            setOpenIssueId(item.id);
          }}
        />
      );
    }
    const back = (): void => {
      setOpenIssueId(undefined);
    };
    if (issue === undefined || issue.status === 'loading') {
      return <StateNotice copy={copy} state="loading" />;
    }
    if (issue.status === 'failed') {
      return (
        <StateNotice
          copy={copy}
          state="failed"
          message={issue.message}
          stderr={issue.stderr}
          onRetry={refresh}
        />
      );
    }
    const detail: IssueDetailRecord = issue.value.item;
    return (
      <IssueDetail
        copy={copy}
        item={detail}
        meta={tables}
        truncated={issue.value.truncated}
        onBack={back}
      />
    );
  };

  /** The plan or milestone view, list or detail. */
  const containerView = (tab: 'plan' | 'milestone'): ReactElement => {
    if (active === undefined) {
      return (
        <ContainerList
          copy={copy}
          row={(item) => containerRow(item, copy)}
          state={containers}
          allStates={containerAllStates}
          onAllStates={(next) => {
            setContainerAllStates(next);
            setContainerPage(1);
          }}
          onRefresh={refresh}
          onPage={setContainerPage}
          onSelect={(item) => {
            setOpenContainer({ kind: tab, id: item.id });
          }}
        />
      );
    }
    const back = (): void => {
      setOpenContainer(undefined);
    };
    if (container === undefined) {
      return <StateNotice copy={copy} state="loading" />;
    }
    return (
      <ContainerDetail
        copy={copy}
        kind={tab}
        state={container}
        issues={embeddedIssues}
        meta={tables}
        onBack={back}
        onRefresh={refresh}
        onOpenIssue={(id) => {
          setView('view.issues');
          setOpenIssueId(id);
        }}
        onOpenPlan={(id) => {
          setView('view.plans');
          setOpenContainer({ kind: 'plan', id });
        }}
      />
    );
  };

  return (
    <div style={SHELL}>
      <div style={HEADER} role="tablist" aria-label={copy('type.label')}>
        {VIEW_KEYS.map((key) => {
          const active = key === view;
          return (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => {
                setView(key);
              }}
              style={active ? TAB_ACTIVE : TAB}
            >
              {copy(key)}
            </button>
          );
        })}
      </div>
      {meta.status === 'failed' && (
        <p style={{ ...NOTE, padding: '6px 10px 0' }}>{copy('panel.metaUnavailable')}</p>
      )}
      {view === 'view.issues'
        ? issueView()
        : containerView(view === 'view.plans' ? 'plan' : 'milestone')}
    </div>
  );
}
