/**
 * Minimal structural types for the DSH *client* surface.
 *
 * The browser half may not import any `@deepseek-ai/*` type package (only the
 * frozen platform module table is importable at runtime, and the host's type
 * packages are not in it), so — exactly as on the host side — these are
 * structural approximations of the services the panel consumes. Verify against
 * the live page with `cordis_inspect_query` (client `Slots.listSubTree`).
 */
import type {
  ContainerDetail,
  IssueItem,
  MilestoneItem,
  MintDagPayload,
  MintDetailPayload,
  MintIssuePayload,
  MintListPayload,
  MintMetaPayload,
  MintResponse,
  PlanItem,
} from '../records.js';
import type { CopyTranslate, Translate } from './copy.js';

export type {
  ContainerChild,
  ContainerDetail,
  DagNodeMetrics,
  DagNodeView,
  DagPhase,
  DagStatus,
  DagVerdict,
  DagView,
  IssueDetail,
  IssueItem,
  IssuePlacement,
  LabelItem,
  MilestoneItem,
  MintDagPayload,
  MintDetailPayload,
  MintIssuePayload,
  MintListPayload,
  MintMetaPayload,
  MintResponse,
  PlanItem,
} from '../records.js';

/** The translate function a locale namespace binds. */
export type { Translate };

/** Subset of the client `locale` service. */
export interface LocaleServiceLike {
  /**
   * Single-locale form. The typed two-argument form is unavailable out of tree:
   * it requires every built-in locale's dictionary and a namespace merged into
   * the host's own key table.
   */
  register(namespace: string, locale: string, dict: Record<string, string>): () => void;
  bind(namespace: string): Translate;
}

/** One guide entry a tab type contributes to the "new tab" page. */
export interface GuideEntryLike {
  id: string;
  order: number;
  title: () => string;
  description?: () => string;
  /** A primitives `Icon*` component, or omitted for the guide's placeholder. */
  icon?: unknown;
}

/** Stage one: what a tab type is. */
export interface TabDefinitionLike {
  id: string;
  kind: string;
  priority?: 'extension' | 'builtin' | 'fallback';
  multiple?: boolean;
  keepMounted?: boolean;
  /** Resource-address globs; omitted for a page type, which is opened by kind. */
  patterns?: readonly string[];
  title: () => string;
  guide?: GuideEntryLike[];
}

/** Subset of the right sidebar's tab-type registry (`ctx.sidebarRightTabs`). */
export interface SidebarRightTabsLike {
  register(definition: TabDefinitionLike): () => void;
}

/** One open tab, as `openTabs.getSnapshot()` reports it. */
export interface SidebarOpenTabLike {
  sessionId: string;
  kind: string;
}

/**
 * Subset of the right sidebar runtime (`ctx.sidebarRight`).
 *
 * Only what the DAG tab's auto-open needs: the current on-screen session
 * (`mounted`), what is already open (`openTabs`), and the one call that opens a
 * page type. `subscribe` stays optional — the prober polls instead, so it works
 * against a double that only implements snapshots.
 */
export interface SidebarRightLike {
  openTab(kind: string, options?: { params?: Record<string, unknown> }): void;
  readonly mounted: {
    getSnapshot(): string | undefined;
    subscribe?(listener: (value: string | undefined) => void): () => void;
  };
  readonly openTabs: { getSnapshot(): readonly SidebarOpenTabLike[] };
}

/** Registration options for a keyed slot body. */
export interface SlotRegistrationLike {
  name: string;
  /** The tab definition's `id`: the seat dispatches by it. */
  key: string;
  /** Binds the framework-managed `t` seat to this namespace. */
  locale?: string;
  /** Extra props, computed from the slot's standard session identity. */
  inject?: (sessionId: string) => Record<string, unknown>;
}

/** Subset of the client `slots` service. */
export interface SlotsServiceLike {
  inject(name: string, register: () => unknown): void;
  register(options: SlotRegistrationLike, component: unknown): unknown;
}

/** The client context `apply` receives: root-scoped services, already waited for. */
export interface ClientContextLike {
  locale: LocaleServiceLike;
  slots: SlotsServiceLike;
  sidebarRightTabs: SidebarRightTabsLike;
  /**
   * The right sidebar runtime. Optional on purpose: `inject` declares the
   * package, but a lean context (a test double, a host without the sidebar)
   * simply has no such service, and the panel must still register.
   */
  sidebarRight?: SidebarRightLike;
  /** Owns a registration for the plugin's lifetime; the host always provides it. */
  effect?(callback: () => unknown, label?: string): unknown;
}

/** What the panel's transport exposes to its views. */
export interface MintApiLike {
  issues(
    query: Record<string, string | undefined>,
    signal?: AbortSignal
  ): Promise<MintResponse<MintListPayload<IssueItem>>>;
  plans(
    query: Record<string, string | undefined>,
    signal?: AbortSignal
  ): Promise<MintResponse<MintListPayload<PlanItem>>>;
  milestones(
    query: Record<string, string | undefined>,
    signal?: AbortSignal
  ): Promise<MintResponse<MintListPayload<MilestoneItem>>>;
  /** One issue in full: the list fields plus the body. */
  issue(id: number, signal?: AbortSignal): Promise<MintResponse<MintIssuePayload>>;
  /**
   * The panel's lookup tables in one read: plans, milestones, labels, and where
   * each issue sits. Nothing a row needs per item lives on the item itself.
   *
   * `fresh` bypasses the host's short placement memo (#105): the panel's own
   * refresh action sets it, so an attachment changed a second ago shows up now.
   */
  meta(signal?: AbortSignal, fresh?: boolean): Promise<MintResponse<MintMetaPayload>>;
  plan(id: number, signal?: AbortSignal): Promise<MintResponse<MintDetailPayload<ContainerDetail>>>;
  milestone(
    id: number,
    signal?: AbortSignal
  ): Promise<MintResponse<MintDetailPayload<ContainerDetail>>>;
  /**
   * The plan DAG of this session (plan #31).
   *
   * Unlike every other read it is keyed by the *session file* rather than the
   * project, and a missing file is a normal answer (`dag: null`), not a failure.
   */
  dag(signal?: AbortSignal): Promise<MintResponse<MintDagPayload>>;
}

/** The actions a tab body may take on its own occurrence. */
export interface TabActionsLike {
  /** Bind page operations until the body unmounts; returns the disposer. */
  bindCommands(commands: { refresh?: () => void }): () => void;
}

/** Live information the seat hands a tab body (`useTabInfo()`). */
export interface TabInfoLike {
  sidebar: { expanded: boolean; fullscreen: boolean };
  panel: { id: string };
  tab: {
    /** Only the foreground session is visible. */
    visible: boolean;
    /** Aborted when the tab record disappears or this plugin unloads. */
    signal: AbortSignal;
    navigation: { revision: number };
    actions: TabActionsLike;
  };
}

/** Props the panel body receives: session identity, copy, transport, and the tab. */
export interface MintBodyProps {
  /** The session whose project the panel reads; delivered by the slot. */
  sessionId: string;
  /**
   * The copy seat. Injected (not the framework's `t`) so keys are the checked
   * `CopyKey` union instead of the framework's open string domain; both built-in
   * locales carry a complete dictionary, and a key none carries shows as itself.
   */
  copy: CopyTranslate;
  /** Transport injected by `apply`. */
  api: MintApiLike;
  /**
   * The seat's tab-info hook. Optional so the body can also be rendered in a
   * lean harness (a test, a future surface) without the sidebar right runtime.
   */
  useTabInfo?: () => TabInfoLike | undefined;
}
