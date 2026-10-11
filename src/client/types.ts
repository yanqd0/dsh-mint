/**
 * 客户端面的最小结构类型：浏览器半边不能 import 任何 `@deepseek-ai/*` 类型包（运行时只有平台冻结的
 * 模块表可 import，宿主的类型包不在其中），故与宿主侧一样按结构近似面板消费的服务；核对活页面用
 * `cordis_inspect_query`（客户端 `Slots.listSubTree`）。
 */
import type {
  ContainerDetail,
  IssueItem,
  MilestoneItem,
  MintAgentsPayload,
  MintDagPayload,
  MintDetailPayload,
  MintIssuePayload,
  MintListPayload,
  MintMetaPayload,
  MintResponse,
  PlanItem,
} from '../shared/records.js';
import type { CopyTranslate, Translate } from './copy.js';

export type {
  AgentNodeView,
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
  LabelItem,
  MilestoneItem,
  MintAgentsPayload,
  MintDagPayload,
  MintDetailPayload,
  MintIssuePayload,
  MintListPayload,
  MintMetaPayload,
  MintResponse,
  PlanItem,
} from '../shared/records.js';

export type { Translate };

/** Subset of the client `locale` service. */
export interface LocaleServiceLike {
  /**
   * 单 locale 形式。带类型的双参数形式在仓外用不了：它要求每个内置 locale 的词典，
   * 以及把命名空间并进宿主自己的 key 表。
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
 * 右侧栏运行时（`ctx.sidebarRight`）的子集，只取 DAG tab 自动打开要用的三样：当前屏幕会话
 * （`mounted`）、已开 tab（`openTabs`），以及开一个页类型的那次调用。`subscribe` 保持可选——
 * 探针用轮询，故只实现快照的替身也能工作。
 */
export interface SidebarRightLike {
  openTab(kind: string, options?: { params?: Record<string, unknown> }): void;
  readonly mounted: {
    getSnapshot(): string | undefined;
    subscribe?(listener: (value: string | undefined) => void): () => void;
  };
  readonly openTabs: { getSnapshot(): readonly SidebarOpenTabLike[] };
}

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
   * 右侧栏运行时。故意可选：`inject` 只声明了包，而精简上下文（测试替身、没有右侧栏的宿主）
   * 根本没有这个服务，面板仍必须完成注册。
   */
  sidebarRight?: SidebarRightLike;
  /** Owns a registration for the plugin's lifetime; the host always provides it. */
  effect?(callback: () => unknown, label?: string): unknown;
}

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
  issue(id: number, signal?: AbortSignal): Promise<MintResponse<MintIssuePayload>>;
  /**
   * 面板的查找表一次读完：plan、milestone 与 label。
   *
   * issue 的归属现在随 issue 行一起下发，故这次读只带行渲染用的版本/颜色字典；
   * 字典每次请求都重读，所以面板刷新不需要额外标志。
   */
  meta(signal?: AbortSignal): Promise<MintResponse<MintMetaPayload>>;
  plan(id: number, signal?: AbortSignal): Promise<MintResponse<MintDetailPayload<ContainerDetail>>>;
  milestone(
    id: number,
    signal?: AbortSignal
  ): Promise<MintResponse<MintDetailPayload<ContainerDetail>>>;
  /**
   * The plan DAG of this session.
   *
   * Unlike every other read it is keyed by the *session file* rather than the
   * project, and a missing file is a normal answer (`dag: null`), not a failure.
   */
  dag(signal?: AbortSignal): Promise<MintResponse<MintDagPayload>>;
  /**
   * The subagent tree of this session.
   *
   * Same session-keyed shape as {@link dag}, except the data is entirely live
   * host state: an unreadable tree is an empty `nodes` array, never a failure.
   */
  agents(signal?: AbortSignal): Promise<MintResponse<MintAgentsPayload>>;
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

export interface MintBodyProps {
  /** The session whose project the panel reads; delivered by the slot. */
  sessionId: string;
  /**
   * copy 座位。注入它而不用框架的 `t`，是为了让 key 是被检查的 `CopyKey` 联合而非框架的
   * 开放字符串域；两个内置 locale 都带完整词典，都没有的 key 就显示 key 本身。
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
