/**
 * The DAG tab's auto-open prober (plan #31 §4.7).
 *
 * A session with a plan DAG should not need the user to know a tab exists for
 * it. The host cannot push (no SSE primitive), so the browser half asks at a low
 * frequency whether this session has a DAG yet, and opens the tab once when the
 * answer turns to yes.
 *
 * Two deliberate properties keep this cheap and safe to leave running:
 *
 * - **Page-type uniqueness does the de-duplication.** A `multiple !== true` type
 *   has one address per session, so a repeated `openTab` focuses rather than
 *   stacks; the open-tab check is a courtesy that saves the call, not the
 *   correctness argument.
 * - **Every failure is swallowed.** A dead route, a dead session, or a transient
 *   fetch error must not surface in a conversation nobody asked to interrupt.
 */
import type { MintDagPayload } from '../shared/records.js';
import type { MintApiLike, SidebarOpenTabLike, SidebarRightLike } from './types.js';

/** How often the prober looks for a DAG (5s: a plan does not appear instantly). */
export const DAG_PROBE_MS = 5000;

/**
 * The tab type's discriminator, and the guide entry's id.
 *
 * Exported from here rather than from the plugin entry so the prober and the
 * registration cannot name two different kinds.
 */
export const DAG_TAB_KIND = 'plan-dag';

/**
 * Whether this payload is a reason to open the tab.
 *
 * A missing document is not (there is nothing to draw), and neither is an empty
 * one — an `init` with no nodes yet would otherwise steal focus for a blank
 * canvas. An already-open tab is not either, however the answer changed since.
 */
export function shouldOpenDag(
  payload: MintDagPayload,
  openTabs: readonly SidebarOpenTabLike[],
  sessionId: string
): boolean {
  if (payload.dag === null || payload.dag.nodes.length === 0) return false;
  return !openTabs.some((tab) => tab.sessionId === sessionId && tab.kind === DAG_TAB_KIND);
}

/** What the prober needs from the surrounding plugin: the seat and a transport. */
export interface DagOpenHost {
  sidebarRight: SidebarRightLike;
  apiFor(sessionId: string): Pick<MintApiLike, 'dag'>;
}

export interface DagOpenOptions {
  /** Probe period; the tests inject a smaller one. */
  intervalMs?: number;
  /** Test seam; defaults to the page's timers. */
  timers?: {
    setInterval(cb: () => void, ms: number): unknown;
    clearInterval(handle: unknown): void;
  };
  /** Whether a probe is worth making; hidden pages skip the request entirely. */
  visible?: () => boolean;
}

/**
 * Start probing for this session's DAG, opening the tab once one appears.
 *
 * @param host - the sidebar seat and the transport factory, both read per tick
 *   (the on-screen session changes while the prober lives).
 * @param options - probe period, timer seam, and the visibility gate.
 * @returns the disposer: stops the timer and cancels any further probe.
 */
export function startDagAutoOpen(host: DagOpenHost, options: DagOpenOptions = {}): () => void {
  const intervalMs = options.intervalMs ?? DAG_PROBE_MS;
  const timers = options.timers ?? {
    setInterval: (cb: () => void, ms: number): unknown => setInterval(cb, ms),
    clearInterval: (handle: unknown): void => {
      clearInterval(handle as ReturnType<typeof setInterval>);
    },
  };
  const visible = options.visible ?? ((): boolean => true);

  let stopped = false;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    timers.clearInterval(handle);
  };

  const tick = async (): Promise<void> => {
    if (stopped) return;
    if (!visible()) return;
    const sessionId = host.sidebarRight.mounted.getSnapshot();
    if (sessionId === undefined) return;
    const payload = await host.apiFor(sessionId).dag();
    if (stopped) return;
    if (payload.ok === false) return;
    // The mount line turned the feature off: stop asking, this session cannot
    // re-enable it without a reload.
    if (payload.autoOpen === false) {
      stop();
      return;
    }
    if (shouldOpenDag(payload, host.sidebarRight.openTabs.getSnapshot(), sessionId)) {
      host.sidebarRight.openTab(DAG_TAB_KIND);
    }
  };

  // `stop` is only reachable from inside `tick` (after this line has run, since
  // `setInterval` returns before it ever fires) or from the disposer below, so
  // the handle is always initialized by the time it is read.
  const handle = timers.setInterval(() => {
    // A probe failing is an expected state, not an event: the next tick is the
    // retry, and nothing in a conversation should hear about it.
    void tick().catch(() => {});
  }, intervalMs);

  return stop;
}
