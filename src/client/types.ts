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
  MintBodyPayload,
  MintDetailPayload,
  MintListPayload,
  MintResponse,
  PlanItem,
} from '../records.js';
import type { CopyTranslate, Translate } from './copy.js';

export type {
  ContainerChild,
  ContainerDetail,
  IssueItem,
  MilestoneItem,
  MintBodyPayload,
  MintDetailPayload,
  MintListPayload,
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
  milestones(signal?: AbortSignal): Promise<MintResponse<MintListPayload<MilestoneItem>>>;
  issueBody(id: number, signal?: AbortSignal): Promise<MintResponse<MintBodyPayload>>;
  plan(id: number, signal?: AbortSignal): Promise<MintResponse<MintDetailPayload<ContainerDetail>>>;
  milestone(
    id: number,
    signal?: AbortSignal
  ): Promise<MintResponse<MintDetailPayload<ContainerDetail>>>;
}

/** Props the panel body receives: session identity, copy, and transport. */
export interface MintBodyProps {
  /** The session whose project the panel reads; delivered by the slot. */
  sessionId: string;
  /** Translation seat bound to the `mint` namespace, key-checked against the copy. */
  t: CopyTranslate;
  /** Transport injected by `apply`. */
  api: MintApiLike;
}
