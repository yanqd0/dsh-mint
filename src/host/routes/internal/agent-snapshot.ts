/**
 * 子代理树的兜底快照：把一次**实时**读数落成按会话的文件。
 *
 * 实时读数只在会话还活着时可读（`agents` 注册表 + 会话投影），而面板可能在会话结束后仍然开着，
 * 甚至跨一次宿主重启。所以路由在每次拿到非空实时读数时顺手写一份文档，读不到实时数据时改用这
 * 份文档作答——这就是「live 优先、快照兜底」。本模块只负责**写**这一侧与「值不值得写」的判定，
 * 读与路径在 `agent-tree-store.ts`。
 *
 * 写是**尽力而为**：这是给面板的锦上添花，为一次落盘把路由的 200 变成错误绝不值得（与
 * `mint-handler.ts` 里 DAG 采样的 `flushRememberedSample` 同一条纪律）。
 */
import { AGENT_TREE_VERSION, updateAgentTree } from '../../../dag/agent-tree/agent-tree-store.js';
import type { AgentTreeRead as CollectedAgentTree } from '../../../dag/agent-tree/agent-tree.js';
import type { AgentNodeView, DagNodeMetrics } from '../../../shared/records.js';

/**
 * 参与快照比较的计数字段。
 *
 * **不含 `elapsed_ms`**：时长只增不减，而实时读数的 `sampled_at` 每轮都在前进，把它算进来等于
 * 「每次轮询都判为变了」，于是每 2s 写一次盘。已结算节点的其余数字才是回头还要看的东西。
 */
const SNAPSHOT_METRIC_FIELDS = [
  'tokens',
  'uncached_input',
  'cache_read',
  'cache_write',
  'output',
  'context',
  'steps',
] as const satisfies readonly (keyof DagNodeMetrics)[];

function sameNode(before: AgentNodeView, after: AgentNodeView): boolean {
  if (
    before.id !== after.id ||
    before.kind !== after.kind ||
    before.parent !== after.parent ||
    before.depth !== after.depth ||
    before.label !== after.label ||
    before.mode !== after.mode ||
    before.running !== after.running ||
    before.seenAt !== after.seenAt
  ) {
    return false;
  }
  return SNAPSHOT_METRIC_FIELDS.every(
    (field) => before.metrics?.[field] === after.metrics?.[field]
  );
}

/**
 * 已经落盘的那棵树与刚读到的这棵树是否不同。
 *
 * 比较**顺序**：面板画的是先序列表，顺序变了就是一次重排。文件缺失（`undefined`）一律算变——没有
 * 快照可兜底，这次读数正该成为它。
 */
export function agentSnapshotChanged(
  stored: AgentNodeView[] | undefined,
  fresh: readonly AgentNodeView[]
): boolean {
  if (stored === undefined) return true;
  if (stored.length !== fresh.length) return true;
  return stored.some((node, index) => {
    const next = fresh[index];
    return next === undefined || !sameNode(node, next);
  });
}

/** 一次落盘的输入：会话、刚读到的实时树、目录覆写与这次读数的钟。 */
export interface FlushAgentSnapshotInput {
  sessionId: string;
  read: CollectedAgentTree;
  dir: string | undefined;
  sampledMs: number;
}

/**
 * 把这次实时读数落成快照，或在它没带来新东西时跳过。
 *
 * 版本从 1 起：第一份快照就是这份文档的初版，之后每写入一次真正不同的树才 `+1`；于是文件存在
 * 而没有 revision 变化，就说明「这棵树确实没动过」，面板的重渲守卫据此跳过。
 */
export async function flushAgentSnapshot(input: FlushAgentSnapshotInput): Promise<void> {
  const { sessionId, read, dir, sampledMs } = input;
  // 空树不是快照：它什么都没答（宿主没挂、读抛错），写成文件只会把上一次好快照抹掉。
  if (read.nodes.length === 0) return;
  const freshDoc = (revision: number) => ({
    version: AGENT_TREE_VERSION,
    session: sessionId,
    revision,
    sampled_at: sampledMs,
    nodes: read.nodes,
  });
  try {
    await updateAgentTree(
      sessionId,
      (state) => {
        if (state.state !== 'ok') return { doc: freshDoc(1) };
        if (!agentSnapshotChanged(state.doc.nodes, read.nodes)) return { skip: true };
        return { doc: freshDoc(state.doc.revision + 1) };
      },
      dir
    );
  } catch {
    // 尽力而为：写失败只让*下一次*答案少它本该显示的兜底树，本次答案照给。
  }
}
