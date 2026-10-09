/**
 * DAG tab 的自动打开探测器（规格见 `notes/plan-dag.md`）。
 *
 * 会话里有 plan DAG 时，不该要求用户先知道有这么个 tab。宿主没有推送手段（没有 SSE 原语），
 * 所以由浏览器侧低频询问本会话是否已有 DAG，答案变成「有」时打开一次。
 *
 * 两条刻意的性质让它可以便宜且安全地常驻：
 *
 * - **去重靠页面类型的唯一性**：`multiple !== true` 的类型每会话只有一个地址，重复
 *   `openTab` 只会聚焦而不会叠开；查已开 tab 只是省一次调用的人情，不是正确性论据。
 * - **一切失败都吞掉**：路由已死、会话已死、临时 fetch 错误，都不得闯进没人要求打断的对话。
 */
import type { MintDagPayload } from '../shared/records.js';
import type { MintApiLike, SidebarOpenTabLike, SidebarRightLike } from './types.js';

/** 探测间隔（5s：plan 不会瞬间出现）。 */
export const DAG_PROBE_MS = 5000;

/**
 * tab 类型的判别值，也是 guide 条目的 id。
 *
 * 从本模块而非插件入口导出，探测器与注册处就不可能叫出两种 kind。
 */
export const DAG_TAB_KIND = 'plan-dag';

/**
 * 这份 payload 是否构成打开 tab 的理由。
 *
 * 没有文档不是理由（没东西可画），空文档也不是——空节点的 `init` 会为一块空白画布抢走
 * 焦点。已经开着的 tab 同样不是，无论答案此后怎么变。
 */
export function shouldOpenDag(
  payload: MintDagPayload,
  openTabs: readonly SidebarOpenTabLike[],
  sessionId: string
): boolean {
  if (payload.dag === null || payload.dag.nodes.length === 0) return false;
  return !openTabs.some((tab) => tab.sessionId === sessionId && tab.kind === DAG_TAB_KIND);
}

export interface DagOpenHost {
  sidebarRight: SidebarRightLike;
  apiFor(sessionId: string): Pick<MintApiLike, 'dag'>;
}

export interface DagOpenOptions {
  /** 探测周期；测试注入一个更小的值。 */
  intervalMs?: number;
  /** 测试缝；缺省用页面的定时器。 */
  timers?: {
    setInterval(cb: () => void, ms: number): unknown;
    clearInterval(handle: unknown): void;
  };
  /** 这次是否值得探测；页面隐藏时整个请求都跳过。 */
  visible?: () => boolean;
}

/**
 * 开始探测本会话的 DAG，一旦出现就打开 tab。
 *
 * 座位与传输工厂都按 tick 现读——探测器活着的时候，屏上的会话会变。
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
    // mount 那一行把功能关掉了：别再问了，本会话不重载就开不回来。
    if (payload.autoOpen === false) {
      stop();
      return;
    }
    if (shouldOpenDag(payload, host.sidebarRight.openTabs.getSnapshot(), sessionId)) {
      host.sidebarRight.openTab(DAG_TAB_KIND);
    }
  };

  // `stop` 只能从 `tick` 内部（这一行跑完之后才可能触发，因为 `setInterval` 在它首次
  // 触发之前就返回了）或下面的 disposer 调到，故读 handle 时它一定已初始化。
  const handle = timers.setInterval(() => {
    // 探测失败是预期状态而非事件：下一次 tick 就是重试，对话里谁都不该听说它。
    void tick().catch(() => {});
  }, intervalMs);

  return stop;
}
