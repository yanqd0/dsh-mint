import { runMint } from '../mint/mint.js';
import { planModeState } from './plan-mode.js';
import type { DshContext, PreToolDecisionLike, ToolExecutionLike } from '../shared/types.js';

/**
 * 主机的计划模式退出工具。两个关心它的监听方（本门禁与 `reminders.ts` 的计划模式
 * 记录提醒）都从这里读名字，宿主契约因此只有一处落点。
 */
export const EXIT_PLAN_MODE = 'exit_plan_mode';

/**
 * 满足门禁的计划状态。
 *
 * 门禁问的是「离开计划模式前，本项目有没有留下可拆解的 mint 记录？」，所以接受
 * **已拆解且未终结**的计划：
 *
 * - `running` —— mint 由活跃子级（planned/dev/test）推导而来，按构造就已拆解；
 * - 挂了至少一个 issue 的 `open` —— 登记形态：新建计划、子级全 `open` 同样推导为
 *   `open`（mint 的 `container/derive.rs`），此前要求必须是 `running` 时，任何把建议
 *   登记到别的 plan/milestone 而子级留 `open` 的新会话都会被卡死。
 *
 * `partial`/`done`/`dropped` 是完成态，永不满足门禁；**空**计划也不行——零子级正是
 * `issue_count` 检查要堵的洞。
 */
const DECOMPOSED_PLAN_STATUSES: ReadonlySet<string> = new Set(['running', 'open']);

/**
 * 一个 `plan list --json` 项是否是可被门禁接受的记录。
 *
 * 导出是为了让判定只有一个落点、且有直接的单元测试（监听器只把它与 mint 的答案
 * 组合起来）。
 */
export function isDecomposedPlan(item: { status?: unknown; issue_count?: unknown }): boolean {
  if (typeof item.status !== 'string' || !DECOMPOSED_PLAN_STATUSES.has(item.status)) return false;
  // 推导出的 running 已证明有活跃子级：保持它的短路判定，逐字节不变。
  if (item.status === 'running') return true;
  // open 同时覆盖「还没挂任何 issue」与「子级全 open」，只有前者必须继续关门。
  // count 读不出来就放行——与本文件其他读不出来的答案一样，不得卡死计划模式退出。
  return typeof item.issue_count !== 'number' || item.issue_count > 0;
}

/**
 * 门禁读到的一行 `plan list --json`。
 *
 * `milestone_id` 可选：省略它的 mint 会把所有计划归进同一个桶，那正是项目级计数。
 */
export interface PlanListItem {
  id?: unknown;
  status?: unknown;
  issue_count?: unknown;
  milestone_id?: unknown;
}

/** 计划行所属的 milestone 桶；没有数字 milestone 的行共用一个桶。 */
function milestoneBucket(item: PlanListItem): string {
  return typeof item.milestone_id === 'number' ? String(item.milestone_id) : 'none';
}

/**
 * 同一个 milestone 下第一个「两个及以上 **running** 计划」的簇。
 *
 * 纪律是「一个 milestone 同时只跑一个计划」，所以违规只在同一个桶内成立：不同
 * milestone 的计划是用户主动并行的（`milestone set <id> --status running --force`），
 * 门禁不得与这种被批准的并行版本对抗。`milestone_id` 缺失或读不出来时归进 `none`
 * 桶，而不是解除规则——这样的行彼此仍然碰撞，而为一个读不出来的**键**失败关闭，
 * 会让 mint 的 list 输出漂移时卡死计划模式退出。
 */
export function multiRunningCluster(items: readonly PlanListItem[]): readonly PlanListItem[] {
  const buckets = new Map<string, PlanListItem[]>();
  for (const item of items) {
    if (item.status !== 'running') continue;
    const key = milestoneBucket(item);
    const bucket = buckets.get(key);
    if (bucket === undefined) {
      buckets.set(key, [item]);
      continue;
    }
    bucket.push(item);
    if (bucket.length >= 2) return bucket;
  }
  return [];
}

/** 簇内各计划的 id，用于拒绝文案（行没有 id 时写 `#?`）。 */
function clusterIds(cluster: readonly PlanListItem[]): string {
  return cluster.map((item) => (typeof item.id === 'number' ? `#${item.id}` : '#?')).join(', ');
}

/**
 * 门禁背后的计划读取。
 *
 * `--no-page` 必需：mint 的 `plan list` 默认按 id 倒序每页五行，比最新五行更早的
 * 有效记录会被读成「根本没有计划」，从而把会话卡在计划模式里。
 *
 * `--status running` 能让答案更小，却会吃掉门禁的两条不同文案：空答案必须继续表示
 * 「不存在计划」（{@link DENY_REASON}），而非空但没有可拆解计划表示「有计划、都不算
 * 拆解」（{@link UNDECOMPOSED_DENY_REASON}）。默认读本来也只隐藏 `done`，概览不需要
 * 更多。
 */
const PLAN_LIST_ARGV: readonly string[] = ['plan', 'list', '--json', '--no-page'];

const DENY_REASON =
  'No mint plan for this project — create one first with the mint tool: ' +
  'mint({args:["plan","create","<title>","--milestone","<id>"]}), then attach at least one issue, before exiting plan mode.';

/**
 * 有计划但都不算拆解（全为空或已终结）时的拒绝文案。
 *
 * 门禁要的是**记录**而非排期：`plan plan` 是开工动作，所以文案把它写成独立一步，
 * 而不是退出计划模式的前置条件。
 */
const UNDECOMPOSED_DENY_REASON =
  'The mint plans for this project have no issue attached — a plan only counts once it is decomposed: ' +
  'attach at least one with mint({args:["plan","attach","<id>","<issue>"]}); ' +
  'lock the schedule with mint({args:["plan","plan","<id>"]}) when the work starts.';

/**
 * 同一 milestone 已有两个 running 计划时的拒绝文案。
 *
 * 文案必须可行动，因为这条规则只在门禁这里执行（mint 自己只管 milestone、不管计划）：
 * 它点名碰撞的计划，并给出三条收敛路线——把本会话的工作并进 running 计划、把另一个
 * 计划的 `planned` issue 停回、或摘掉那个让已完成计划复活的 open issue（`running`
 * 也可由 `{done|dropped} + open` 的子级集合推导，见 `state-machine.md`）。
 */
function multiRunningReason(cluster: readonly PlanListItem[]): string {
  return (
    `${clusterIds(cluster)} are running in the same milestone — this project works one plan at a time. ` +
    'Attach this session\'s work to the running plan, or stop the other one first: ' +
    'park its planned issues with mint({args:["issue","state","reset","<issue id>"]}) ' +
    '(a plan already in dev/test belongs to another session — hand that back to the user); ' +
    'a finished plan revived by a newly attached open issue is freed with ' +
    'mint({args:["plan","detach","<plan>","<issue>"]}).'
  );
}

/**
 * 会话根本不在计划模式时的拒绝文案。
 *
 * 计划模式未激活时主机仍注册着 `exit_plan_mode`，其 `execute` 会抛
 * `exit_plan_mode is only available in plan mode`——而门禁已经先付了一次 mint 读取。
 * 主机自己的判定才是权威，所以非激活会话直接拿到这条可行动回答：没有什么可退出的，
 * 流程照常继续。
 */
const NOT_IN_PLAN_MODE_DENY_REASON =
  'This session is not in plan mode — there is nothing to exit, and no mint plan has to be registered for it. ' +
  'Continue with the normal workflow: mint({args:["plan","plan","<plan id>"]}) at the start of work, ' +
  'then issue state start per issue. To plan first, ask the user to switch the session into plan mode.';

/**
 * `tools/pre-execute` 监听器：本项目没有可拆解的 mint 计划
 * （{@link isDecomposedPlan}）时，或同一 milestone 已有多个 running 计划
 * （{@link multiRunningCluster}）时拦截 `exit_plan_mode`，把主机的计划机制绑在
 * mint 记录上。
 *
 * 工具名在访问任何服务**之前**先判，mint 调用留在 try 内——mint 挂掉绝不能弄坏无关
 * 的工具调用（fail-open）。会话的项目目录取自工具执行，插件直接 spawn mint，不过会话
 * 沙箱。
 */
export async function planBindListener(
  exec: ToolExecutionLike,
  next: () => Promise<PreToolDecisionLike>,
  entry?: string,
  ctx?: DshContext
): Promise<PreToolDecisionLike> {
  if (exec.name !== EXIT_PLAN_MODE) {
    return next();
  }
  // 计划模式未激活时退出工具仍注册着。与其为一次主机马上就会拒绝的判定去 spawn
  // mint，不如在这里带着可行动理由直接拒。`undefined`（来源不可达，或本会话没观察到）
  // 落到 mint 门禁，即本次检查之前的行为。
  const mode = planModeState(ctx, exec);
  if (mode !== undefined && mode.active === false) {
    return { kind: 'deny', reason: NOT_IN_PLAN_MODE_DENY_REASON };
  }
  try {
    const cwd = exec.agent?.session?.header?.cwd ?? process.cwd();
    const result =
      entry === undefined
        ? await runMint(cwd, PLAN_LIST_ARGV)
        : await runMint(cwd, PLAN_LIST_ARGV, { entry });
    if (!result.ok) {
      return next();
    }
    const plans = JSON.parse(result.text ?? '{}') as {
      items?: PlanListItem[];
    };
    const items = plans.items ?? [];
    // 每个 milestone 至多一个 running 计划。先用门禁已看到的行为证明违规，别让任何
    // fail-open 路径把它吞掉——某一行 `status` 读不出来，不能撤销一桩已经成立的碰撞。
    const cluster = multiRunningCluster(items);
    if (cluster.length >= 2) {
      return { kind: 'deny', reason: multiRunningReason(cluster) };
    }
    // 形状未知（例如某个 mint 的 `plan list --json` 还没有推导出的 status）时放行：
    // 读不出来的答案不得卡死计划模式退出。只要一行读不出来就足以不信**计数**，所以
    // 这里是「每一行都可读」而不是「至少一行可读」。
    if (items.some((plan) => typeof plan.status !== 'string')) {
      return next();
    }
    if (!items.some(isDecomposedPlan)) {
      return { kind: 'deny', reason: items.length === 0 ? DENY_REASON : UNDECOMPOSED_DENY_REASON };
    }
  } catch {
    // 降级为放行——不能让 mint 失败卡死计划模式退出
  }
  return next();
}

/** 在 `tools/pre-execute` 上注册计划绑定检查。 */
export function installPlanBinding(ctx: DshContext, entry?: string): () => void {
  return ctx.on(
    'tools/pre-execute',
    (exec: ToolExecutionLike, next: () => Promise<PreToolDecisionLike>) =>
      planBindListener(exec, next, entry, ctx)
  );
}
