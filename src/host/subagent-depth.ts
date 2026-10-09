/**
 * 宿主 `subagent.maxDepth` 生效值的探测，与「委派被降级」时的文案。
 *
 * 事实依据（本仓实测，勿凭猜改）：宿主服务名 `subagents`，公开方法
 * `resolveMaxDepth(configured?: number | 'provider-managed'): number | undefined`；**无参**
 * 调用返回服务级生效值（每次现读 `config.maxDepth`，schema 默认 1 且声明为
 * `.volatile()`，所以设置改完**下一次委派**就生效、不必重启）。`ctx.get('subagents')`
 * 免 `inject` 声明即可读（本仓已这样读 `agents` / `sessionProjections`）。
 *
 * 本模块只做「读不到就说不出来」：读不到**不降级**（`unknown` 一律不渲染文案），
 * 因为按错误的深度给建议比不给更糟。
 */
import type { DshContext } from '../shared/types.js';

/** 宿主 `subagents` 服务中本插件消费的那一个方法。 */
export interface SubagentsLike {
  resolveMaxDepth?(configured?: number | 'provider-managed'): unknown;
}

/** 读到的生效值，或「读不出来」。 */
export type SubagentDepth = { kind: 'reported'; maxDepth: number } | { kind: 'unknown' };

/** 委派形态：两级 / 只有一级子代理 / 禁派 / 读不到（不猜）。 */
export type DelegationShape = 'two-level' | 'single-agent' | 'no-delegation' | 'unknown';

/**
 * 读服务级生效的 `maxDepth`。
 *
 * 服务缺失、方法缺失、调用抛错、返回值不是非负安全整数（含 `undefined`）一律
 * `{ kind: 'unknown' }`：**绝不抛**，也绝不猜。这是一个附加信号，读不到只该让
 * 文案消失，不该让工具调用或上下文装配失败。
 */
export function readSubagentDepth(ctx: DshContext): SubagentDepth {
  try {
    const service = ctx.get?.('subagents');
    if (typeof service !== 'object' || service === null) return { kind: 'unknown' };
    // 以**成员访问**调用，而不是先把方法取出来：取出会丢掉接收者（宿主服务的方法可能
    // 依赖 `this`），也正是 `@typescript-eslint/unbound-method` 挡的那种写法。
    const subagents = service as SubagentsLike;
    if (typeof subagents.resolveMaxDepth !== 'function') return { kind: 'unknown' };
    const value = subagents.resolveMaxDepth();
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      return { kind: 'unknown' };
    }
    return { kind: 'reported', maxDepth: value };
  } catch {
    return { kind: 'unknown' };
  }
}

/**
 * 生效值 → 委派形态。
 *
 * `0` 禁派、`1` 只允许直接子级（dev/test 对里的二级子代理派不出去）、`≥2` 才是本仓
 * skill 假设的两级；`unknown` **不降级**——读不到就什么都不说。
 */
export function delegationShape(depth: SubagentDepth): DelegationShape {
  if (depth.kind === 'unknown') return 'unknown';
  if (depth.maxDepth === 0) return 'no-delegation';
  if (depth.maxDepth === 1) return 'single-agent';
  return 'two-level';
}

/**
 * 工具回答里追加的降级提示（`init`/`add`/`get` 的成功回答）。
 *
 * 两件事必须都在：**怎么开**（GUI 路径 + 设成几）与**什么时候生效**（下一次委派）。
 * 正常机器（`two-level`）与读不到（`unknown`）返回空串，调用方据此决定要不要加这一行。
 */
export function renderDagDepthNotice(shape: DelegationShape): string {
  if (shape === 'single-agent') {
    return '委派降级：宿主 subagent.maxDepth=1——dev/test 两个节点由同一个子代理收尾（它不再派二级子代理）；要恢复两级委派：设置 → 插件 → 子智能体 → 最大递归深度 改为 2（下一次委派即生效，无需重启）。';
  }
  if (shape === 'no-delegation') {
    return '委派被禁用：宿主 subagent.maxDepth=0——本轮所有节点都要 main 亲跑；要允许委派：设置 → 插件 → 子智能体 → 最大递归深度 改为 ≥2（下一次委派即生效，无需重启）。';
  }
  return '';
}

/**
 * 概览注入里的降级行。
 *
 * 与 {@link renderDagDepthNotice} 同一份事实、不同长度预算：这是一条**每请求**都要发的
 * 行（只在降级时才出现），所以更短，但 GUI 路径与「下一次委派」两个可行动信息一个不少
 * （字节上限由 `tests/guard/injection-size.test.ts` 守）。
 */
export function renderOverviewDepthLine(shape: DelegationShape): string {
  if (shape === 'single-agent') {
    return '[Mint] 委派降级：宿主 subagent.maxDepth=1 → dev/test 对由同一个子代理收尾；要两级就去 设置 → 插件 → 子智能体 → 最大递归深度 设为 2（下一次委派生效）。';
  }
  if (shape === 'no-delegation') {
    return '[Mint] 委派被禁用：宿主 subagent.maxDepth=0 → 本轮节点都由 main 亲跑；设置 → 插件 → 子智能体 → 最大递归深度 设为 ≥2（下一次委派生效）。';
  }
  return '';
}
