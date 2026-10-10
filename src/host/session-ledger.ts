import { isWriteInvocation } from '../mint/cross-project.js';
import { invocationsOf, sessionIdOf } from '../mint/cross-project-gate.js';
import { isOwnProject } from '../mint/own-project.js';
import type {
  DshContext,
  SessionEventLike,
  SessionLike,
  ToolExecutionLike,
  ToolResultLike,
} from '../shared/types.js';

/**
 * 会话内的 mint 写台账。
 *
 * 计划绑定门禁（`planbind.ts`）只能看到项目里*某个*计划是 `running`——那是项目级事实。
 * 「本会话登记过东西吗？」需要一条会话级事实，而唯一可靠证据就是本会话执行过的 mint
 * 写操作。本模块只管这一件事：一个有界的会话 id 集合，记住哪些会话写过**自己的**项目。
 *
 * 刻意做成 `tools/result` 的观察者：
 *
 * - 从不参与 `tools/post-execute` 瀑布，所以改不了也否决不了任何工具内容；
 * - 用与跨项目门禁同一个分类器读调用（`invocationsOf` + `isWriteInvocation`），
 *   让「什么算写」只有一个定义；
 * - mint 的*领域*失败也算（非法状态转移，工具以 `ok: false` 报告而不带 error
 *   result）。台账回答的是「本会话碰过台账没有」，不是「写成功没有」——正因如此
 *   `mint` 工具本身这里无需改动。
 *
 * 跨项目写（`-p <项目>` / `MINT_PROJECT`）不算本会话在**本项目**的工作记录，所以不计数
 * ——但 `-p <本项目>` 算，因为它写的就是默认路径写的那个台账。
 */

/** 记住多少个会话；与其它有界会话表一致。 */
export const MAX_SESSIONS = 100;

/** 至少执行过一次本项目 mint 写的会话，最早在前。 */
const writes = new Set<string>();

/** 日志里记录过「离开计划模式」的会话，最早在前。 */
const planModeExits = new Set<string>();

/**
 * 日志里记录过计划模式 **active** / **inactive** 的会话。
 *
 * 两个互斥集合而非一张 map：与其它会话事实共用有界插入与淘汰，而「未知」就等于「两个
 * 集合都不在」——这正是重启后恢复的会话应得的答案（它的 `plan/mode` 事件发生在上一个
 * 进程里）。
 */
const planModeActive = new Set<string>();
const planModeInactive = new Set<string>();

/** 已经被告知过记录缺失的会话（工具结果提醒或一次性概览行送达）。最早在前。 */
const recordGapNotified = new Set<string>();

/**
 * 把某个会话 id 记进有界集合，淘汰最旧一条。
 *
 * 本模块所有会话事实共用同一个上限与淘汰顺序，于是共用这个插入辅助函数。
 */
function remember(set: Set<string>, sessionId: string): void {
  if (set.has(sessionId)) return;
  if (set.size >= MAX_SESSIONS) {
    const oldest = set.values().next().value;
    if (oldest !== undefined) set.delete(oldest);
  }
  set.add(sessionId);
}

/**
 * 记下本会话的一次本项目 mint 写。
 */
export function recordMintWrite(sessionId: string | undefined): void {
  if (sessionId === undefined) return;
  remember(writes, sessionId);
}

/**
 * 本会话是否已经写过自己项目的台账。
 *
 * 会话 id 未知时答 `false`：调用方要么保持安静（计划模式提醒），要么去问用户
 * （未来的硬门禁），而不是假装已有记录。
 */
export function hasMintWrite(sessionId: string | undefined): boolean {
  return sessionId !== undefined && writes.has(sessionId);
}

/**
 * 记下某会话的日志已离开计划模式。
 *
 * `/plan off` 命令与 GUI 开关都以 `plan/mode` `{active:false}` 会话事件收尾——没有
 * 工具结果可供增补，这正是台账要补的覆盖缺口。
 */
export function notePlanModeExit(sessionId: string | undefined): void {
  if (sessionId === undefined) return;
  remember(planModeExits, sessionId);
}

/**
 * 记下某会话日志最后携带的计划模式值。
 *
 * 计划模式服务在**隔离的 cordis group** 里，根层插件问不到它；这个台账是可达到的兜底
 * （见 `planbind.ts`）。只有主机真正追加过的转移才是已知的——*本*进程从未切换过计划模式
 * 的会话答 `undefined`，调用方必须让路（fail-open）。
 */
export function notePlanModeState(sessionId: string | undefined, active: boolean): void {
  if (sessionId === undefined) return;
  const [add, drop] = active
    ? [planModeActive, planModeInactive]
    : [planModeInactive, planModeActive];
  remember(add, sessionId);
  drop.delete(sessionId);
}

/** 本进程为该会话观察到的计划模式值，或 `undefined`。 */
export function planModeKnownState(sessionId: string | undefined): boolean | undefined {
  if (sessionId === undefined) return undefined;
  if (planModeActive.has(sessionId)) return true;
  if (planModeInactive.has(sessionId)) return false;
  return undefined;
}

/**
 * 标记该会话的「记录缺失」提醒已送达。
 *
 * `exit_plan_mode` 工具路径把提醒追加到工具结果里，那次送达必须同时满足概览通道——
 * 否则一次退出会被播报两次。在**调用**时标记而非在追加文本时标记，使两条通道互斥，
 * 且不受主机何时追加 `plan/mode` 事件影响（主机在下次请求装配时才追加，那时工具结果
 * 早已增补完毕）。
 */
export function noteRecordGapNotified(sessionId: string | undefined): void {
  if (sessionId === undefined) return;
  remember(recordGapNotified, sessionId);
}

/**
 * 取用一次性的「离开计划模式却什么都没登记」提醒。
 *
 * 每个会话至多答一次 `true`，且要三个事实同时成立：会话离开过计划模式、从未写过自己
 * 的项目、还没有送达过提醒。于是非工具路径的退出恰好浮出一行概览，而登记过工作的会话
 * 一行都看不到。
 */
export function takeRecordGapNotice(sessionId: string | undefined): boolean {
  if (sessionId === undefined || !planModeExits.has(sessionId)) return false;
  if (writes.has(sessionId) || recordGapNotified.has(sessionId)) return false;
  remember(recordGapNotified, sessionId);
  return true;
}

/** 清空全部已记录会话（测试：状态不得跨用例泄漏）。 */
export function resetSessionLedger(): void {
  writes.clear();
  planModeExits.clear();
  planModeActive.clear();
  planModeInactive.clear();
  recordGapNotified.clear();
}

/** 工具结果是否携带一次本项目 mint 写。 */
export function isOwnProjectMintWrite(
  exec: ToolExecutionLike,
  result?: ToolResultLike,
  entry?: string
): boolean {
  if (result?.isError === true) return false;
  try {
    const cwd = exec?.agent?.session?.header?.cwd;
    return invocationsOf(exec).some((invocation) => {
      if (!isWriteInvocation(invocation)) return false;
      if (invocation.project === undefined) return true;
      // `-p <本项目>` 写的就是本会话自己的台账，所以它*是*本会话工作的记录——与真正的
      // 跨项目写不同。本项目名未知时保持旧答案：没有证据。
      return cwd !== undefined && isOwnProject(cwd, entry, invocation.project);
    });
  } catch {
    // 读不出来的调用不构成记录的证据。
    return false;
  }
}

/**
 * 注册台账的观察者。
 *
 * `tools/result` 与 `session/event` 都是只发不收的事件（宿主会兜住监听器异常），且事件
 * 类型/工具名在动手之前先判，所以无关活动零成本。
 *
 * `session/event` 监听器正是上述缺口的覆盖点：用户用 `/plan off` 或 GUI 开关离开计划
 * 模式时不产生任何工具结果，信号只能来自会话日志本身。它还记录每个 `plan/mode` 事件的
 * 方向，那是主机计划状态里可达到的一半（计划模式服务本身对本层隔离）。
 */
export function installSessionLedger(ctx: DshContext, entry?: string): () => void {
  const offResult = ctx.on('tools/result', (exec: ToolExecutionLike, result: ToolResultLike) => {
    if (isOwnProjectMintWrite(exec, result, entry)) {
      recordMintWrite(sessionIdOf(exec?.agent));
    }
  });
  const offEvent = ctx.on('session/event', (session: SessionLike, event: SessionEventLike) => {
    try {
      if (event?.type !== 'plan/mode' || typeof event.data?.active !== 'boolean') return;
      // 两个方向门禁都要，不只是退出。
      notePlanModeState(session?.id, event.data.active);
      if (event.data.active === false) notePlanModeExit(session?.id);
    } catch {
      // 读不出来的事件不构成任何证据；保持安静。
    }
  });
  return () => {
    offResult();
    offEvent();
  };
}
