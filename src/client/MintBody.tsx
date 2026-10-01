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
  MintResponse,
  PlanItem,
} from '../records.js';
import { ContainerDetail } from './ContainerDetail.js';
import { ContainerList } from './ContainerList.js';
import { IssueDetail } from './IssueDetail.js';
import { IssueList } from './IssueList.js';
import { StateNotice } from './StateNotice.js';
import { clampPage, containerRow, detailContainer, toLoadState } from './model.js';
import type { LoadState } from './model.js';
import { HEADER, SHELL, TAB, TAB_ACTIVE } from './styles.js';
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

  // Issue view.
  const [allStates, setAllStates] = useState(false);
  const [draft, setDraft] = useState('');
  const [search, setSearch] = useState('');
  const [issuePage, setIssuePage] = useState(1);
  const [issues, setIssues] = useState<LoadState<MintListPayload<IssueItem>>>({ status: 'loading' });
  const [openIssueId, setOpenIssueId] = useState<number | undefined>(undefined);
  const [issue, setIssue] = useState<LoadState<MintIssuePayload> | undefined>(undefined);

  // Plan / milestone views.
  const kind: 'plan' | 'milestone' | undefined =
    view === 'view.plans' ? 'plan' : view === 'view.milestones' ? 'milestone' : undefined;
  const [containerPage, setContainerPage] = useState(1);
  const [containers, setContainers] = useState<
    LoadState<MintListPayload<PlanItem | MilestoneItem>>
  >({ status: 'loading' });
  const [openContainerId, setOpenContainerId] = useState<number | undefined>(undefined);
  const [container, setContainer] = useState<LoadState<ContainerDetailRecord> | undefined>(
    undefined
  );

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
          ...(allStates ? { allStates: '1' } : {}),
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
  }, [api, view, allStates, search, issuePage, reload, signal]);

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
    const query = { page: String(containerPage), pageSize: String(PAGE_SIZE) };
    const request: Promise<MintResponse<MintListPayload<PlanItem | MilestoneItem>>> =
      kind === 'plan' ? api.plans(query, controller.signal) : api.milestones(controller.signal);
    void request.then((response) => {
      setContainers(toLoadState(response));
    });
    return () => {
      signal?.removeEventListener('abort', abort);
      controller.abort();
    };
  }, [api, kind, containerPage, reload, signal]);

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

  // One plan or milestone in full, with the issues it holds.
  useEffect(() => {
    if (openContainerId === undefined || kind === undefined) {
      setContainer(undefined);
      return;
    }
    const controller = new AbortController();
    setContainer({ status: 'loading' });
    const request = kind === 'plan' ? api.plan(openContainerId, controller.signal) : api.milestone(openContainerId, controller.signal);
    void request.then((response) => {
      const state = toLoadState(response);
      setContainer(state.status === 'ready' ? { status: 'ready', value: detailContainer(state.value) } : state);
    });
    return () => {
      controller.abort();
    };
  }, [api, kind, openContainerId, reload]);

  const refresh = (): void => {
    setReload((count) => count + 1);
  };

  /** The issue view, list or detail. */
  const issueView = (): ReactElement => {
    if (openIssueId === undefined) {
      return (
        <IssueList
          copy={copy}
          state={issues}
          search={draft}
          allStates={allStates}
          onSearch={setDraft}
          onAllStates={(next) => {
            setAllStates(next);
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
      <IssueDetail copy={copy} item={detail} truncated={issue.value.truncated} onBack={back} />
    );
  };

  /** The plan or milestone view, list or detail. */
  const containerView = (active: 'plan' | 'milestone'): ReactElement => {
    if (openContainerId === undefined) {
      return (
        <ContainerList
          copy={copy}
          row={containerRow}
          state={containers}
          onRefresh={refresh}
          onPage={setContainerPage}
          onSelect={(item) => {
            setOpenContainerId(item.id);
          }}
        />
      );
    }
    const back = (): void => {
      setOpenContainerId(undefined);
    };
    if (container === undefined) {
      return <StateNotice copy={copy} state="loading" />;
    }
    return (
      <ContainerDetail
        copy={copy}
        kind={active}
        state={container}
        onBack={back}
        onRefresh={refresh}
        onOpenIssue={(id) => {
          setView('view.issues');
          setOpenIssueId(id);
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
      {view === 'view.issues'
        ? issueView()
        : containerView(view === 'view.plans' ? 'plan' : 'milestone')}
    </div>
  );
}
