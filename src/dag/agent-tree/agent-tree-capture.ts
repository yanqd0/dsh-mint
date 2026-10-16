/**
 * 子代理树快照的事件抓拍：宿主一有子代理起止，就把该会话（及其可读祖先）的树落一份快照。
 *
 * - **为什么是事件驱动**：`/dsh-mint/agents` 路由是唯一的另一处写入点，而面板只轮询当前视图
 *   （Nodes / Subagents 二者只有被选中的那个在轮询），于是一个会话可能整段都没被请求过——没
 *   开过面板，或从来没切到 Subagents。事后打开面板就只剩 `main` 一行，兜底快照根本不存在。
 *   宿主事件说的是「这里刚发生了值得留痕的事」，与面板开没开无关。
 * - **抓拍链的口径**：从 `info.id` 沿 `parentSession` 上溯，只收**注册表答得出**的祖先（答不出
 *   下一跳就停，不把中间会话当根猜——写一份错的根文档比不写更坏），`seen` 加跳数上限
 *   {@link MAX_CAPTURE_HOPS} 切断坏注册表里的环；**不收 `info.id` 自己**，因为面板读的是父会话
 *   的树，子代理自己那张图是它的下一层。链里**根会话必然在内**：一级委派的直接父就是根。
 * - **为什么复用 `flushAgentSnapshot`**：判据全在它那里——空树绝不写、逐节点逐字段比对、
 *   `elapsed_ms` 不参与、`revision` 只在树真变时前进、原子写 + 每会话一把锁。这里再抄一份就等于
 *   两处判据要同步。
 * - **层间倒置**：本文件在 `src/dag/`，却 import `src/host/routes/internal/`。本仓已有同向先例：
 *   `src/dag/dag-plan-reminder.ts` import `../host/plan-mode.js`、`src/dag/dag-tool.ts` import
 *   `../host/subagent-depth.js`——抓拍要的不是路由，而是那份**写快照的唯一实现**；为它复制判据，
 *   或把判据搬进 `dag/` 再让路由反向依赖，都比一次现成的 import 贵。
 *
 * 监听器整体 try/catch、不 await、不抛：这是宿主事件总线上的 fire-and-forget 回调，一次落盘
 * 失败（甚至一次服务形状漂移）都不该变成事件派发的错误。
 */
import { isValidDagSession } from '../dag.js';
import { flushAgentSnapshot } from '../../host/routes/internal/agent-snapshot.js';
import { collectAgentTree } from './agent-tree.js';
import { AGENT_TREE_DIR } from './agent-tree-store.js';
import type {
  AgentsLike,
  DshContext,
  SessionProjectionsLike,
  SessionsLike,
  SubagentRunEndInfoLike,
  SubagentRunInfoLike,
} from '../../shared/types.js';

/** 上溯跳数上限：宿主最大委派深度是 2，这个数只用来切断坏注册表里的环。 */
const MAX_CAPTURE_HOPS = 16;

/** 直接父会话 id；注册表答不出，或 `parentSession` 不是非空字符串，都算「链到此为止」。 */
function parentOf(id: string, agents: AgentsLike | undefined): string | undefined {
  const parent = agents?.get(id)?.session.header.parentSession;
  return typeof parent === 'string' && parent.length > 0 ? parent : undefined;
}

/**
 * 要抓拍的会话链：`info.id` 的**全部可读祖先**，不含它自己。
 *
 * 非法 id（拼不出合法路径）跳过不写，但**链还没断**，继续上溯——一跳坏 id 不该埋掉它上面那些
 * 真能读的祖先。
 */
function captureChain(id: string, agents: AgentsLike | undefined): string[] {
  const chain: string[] = [];
  const seen = new Set<string>([id]);
  let hops = 0;
  let cursor = parentOf(id, agents);
  while (cursor !== undefined && hops < MAX_CAPTURE_HOPS) {
    if (seen.has(cursor)) break;
    seen.add(cursor);
    hops += 1;
    if (isValidDagSession(cursor)) chain.push(cursor);
    cursor = parentOf(cursor, agents);
  }
  return chain;
}

/** 在根 ctx 上装两个子代理起止监听，把链上每个会话的实时树落成快照。 */
export function installAgentTreeCapture(ctx: DshContext, dir: string = AGENT_TREE_DIR): void {
  /**
   * 一次起止事件：给链上每个会话读一棵树并落快照。
   *
   * 整条链共用**同一个** `sampledMs`（事件到达时现读一次钟），这样链上各份文档的 `sampled_at`
   * 说的是同一时刻。落盘是异步的，本函数立刻返回：`flushAgentSnapshot` 内部已经 catch 掉写失败，
   * 这里补一层 `.catch` 是为了它上游（`updateAgentTree` 的队列）万一漏出来的拒绝也不冒到宿主。
   */
  const capture = (info: SubagentRunInfoLike): void => {
    try {
      const sampledMs = Date.now();
      // 三个服务按**事件**现查（它们可能晚于本插件挂载），缺失不是错误：`collectAgentTree`
      // 自己把「读不到」翻译成空树。
      const agents = ctx.get?.('agents') as AgentsLike | undefined;
      const sessions = ctx.get?.('sessions') as SessionsLike | undefined;
      const projections = ctx.get?.('sessionProjections') as SessionProjectionsLike | undefined;
      for (const sessionId of captureChain(String(info.id), agents)) {
        // 逐会话独立兜底：一个会话读不出树（宿主形状漂移）不该带走链上其余的。
        try {
          const read = collectAgentTree({
            rootId: sessionId,
            agents,
            sessions,
            projections,
            sampledMs,
          });
          void flushAgentSnapshot({ sessionId, read, dir, sampledMs }).catch(() => undefined);
        } catch {
          // 读是纯内存操作，抛就说明宿主的形状变了；这一次没留下快照而已。
        }
      }
    } catch {
      // 事件派发不能被我们带崩：服务现查、上溯与读树都在这里收口。
    }
  };

  ctx.on('subagent/start', (info: SubagentRunInfoLike) => {
    capture(info);
  });
  ctx.on('subagent/end', (info: SubagentRunEndInfoLike) => {
    capture(info);
  });
}
