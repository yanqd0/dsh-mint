/**
 * 本层能观察到的主机计划模式状态。
 *
 * 从 `planbind.ts` 抽出：计划模式退出门禁与空 DAG 提醒共读**同一份**答案，不各留一份
 * 会漂移的拷贝；行为与抽出前的门禁逐字节一致。
 */
import { planModeKnownState } from './session-ledger.js';
import type { DshContext, ToolExecutionLike } from '../shared/types.js';

/** 调用方已知的会话计划状态。 */
export interface PlanModeStateLike {
  /**
   * 会话日志里那个计划值。**排队中**的选择与此无关：主机的 `exit_plan_mode` 只按
   * 日志里的值拒绝，所以日志为 `false` 时一律拒绝，与主机判定完全对齐。
   */
  active?: unknown;
}

/**
 * 本模块消费的主机 `ctx.sessionProjections` 切片。
 *
 * `stateOf(session, '<key>')` 是宿主插件读会话投影的既有方式（`dsh-terminal-bash`
 * 读 `sandboxMode` 就是这么读的）；计划投影的 key 是 `plan`，其 state 带 `active`。
 */
interface SessionProjectionsLike {
  stateOf(session: unknown, key: string): { active?: unknown } | undefined;
}

/** 计划投影的 key（`@deepseek-ai/dsh-plan-mode` 的 `planProjectionDefinition`）。 */
export const PLAN_PROJECTION_KEY = 'plan';

/**
 * 会话的主机计划状态；读不到时 `undefined`。
 *
 * 显而易见的来源 `ctx.planMode` **在本层不可达**：计划模式插件挂在隔离的 cordis
 * group 里（`@deepseek-ai/dsh-web-app` 的 `presets/standard.patch.yml`：
 * `isolate: { planMode: true }`），0.2.0-rc.2 上实测过（门禁直接落到 mint 读）。
 * 根层插件实际能看到的只有下面两条路，按权威度排序：
 *
 * 1. 会话投影 `plan` —— 正是主机 `exit_plan_mode` 检查的那份状态（`dsh-plan-mode`
 *    的 `loggedActive`），由日志折叠而来，所以能跨 resume/fork 存活；
 * 2. 台账里观察到的 `plan/mode` 事件 —— 覆盖常见情形（本进程内进/出过计划模式），
 *    但对从磁盘恢复的会话只能答 `undefined`。
 *
 * 其余一切（无投影注册表、无 `stateOf`、抛错、答案读不出来）都算「没有证据」：调用方
 * 照旧落到 mint 门禁，所以主机内部漂移也绝不会把计划模式退出卡死。
 */
export function planModeState(
  ctx: DshContext | undefined,
  exec: ToolExecutionLike
): PlanModeStateLike | undefined {
  const session = exec.agent?.session;
  try {
    const projections = ctx?.get?.('sessionProjections') as SessionProjectionsLike | undefined;
    const state = projections?.stateOf?.(session, PLAN_PROJECTION_KEY);
    if (state !== undefined && state !== null) return { active: state.active };
  } catch {
    // Fall through to the ledger: an unreadable projection is not evidence.
  }
  const observed = planModeKnownState(session?.id);
  return observed === undefined ? undefined : { active: observed };
}
