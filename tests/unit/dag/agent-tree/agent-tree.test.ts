import { describe, expect, it } from 'vitest';

import { collectAgentTree } from '../../../../src/dag/agent-tree/agent-tree.js';
import type { CollectAgentTreeInput } from '../../../../src/dag/agent-tree/agent-tree.js';
import type {
  AgentCwdLike,
  AgentsLike,
  SessionProjectionsLike,
} from '../../../../src/shared/types.js';

const ROOT = 'session-root';
const SAMPLED_MS = 1_000_000;

/** 一个会话对象：只有 id 与 durable header 对被测代码有意义。 */
function session(id: string, parentSession?: string): AgentCwdLike {
  return {
    id,
    session: {
      id,
      header: {
        ...(parentSession === undefined ? {} : { parentSession }),
        createdAt: 5,
      },
    },
  };
}

/**
 * 一棵固定的测试树：**每个 id 只给一个会话对象**，与真宿主一样。
 *
 * 宿主的会话注册表答的是会话本身（`AgentCwdLike` 的 `session`），而 agent 注册表答的是
 * 带着那个会话的 Agent——测试与实际读法保持一致。
 *
 * `status` 决定该 id 的 agent 是否在跑；`catalogs` 是该会话的子级列表。
 */
interface Fixture {
  root: string;
  sessions: Map<string, AgentCwdLike>;
  agents: AgentsLike;
  projections: SessionProjectionsLike;
}

function tree(input: {
  /** 每个 id 的 parent；ROOT 必须出现且没有 parent。 */
  parents: Record<string, string | undefined>;
  /** 每个 id 的 agent 状态；缺席即「没有活 agent」（已结束的子代理）。 */
  status?: Record<string, string | undefined>;
  /** 每个 id 的子级 catalog；缺席即空表。 */
  catalogs?: Record<string, readonly unknown[]>;
}): Fixture {
  const sessions = new Map<string, AgentCwdLike>();
  for (const [id, parent] of Object.entries(input.parents)) {
    sessions.set(id, session(id, parent));
  }
  const catalogs = new Map<unknown, readonly unknown[]>();
  for (const [id, children] of Object.entries(input.catalogs ?? {})) {
    const owner = sessions.get(id)?.session;
    if (owner !== undefined) catalogs.set(owner, children);
  }
  return {
    root: ROOT,
    sessions,
    agents: {
      get: (id) => {
        const own = sessions.get(id);
        if (own === undefined) return undefined;
        const status = input.status?.[id];
        return { ...own, ...(status === undefined ? {} : { status }) };
      },
    },
    projections: { stateOf: (s, key) => (key === 'subagentCatalog' ? catalogs.get(s) : undefined) },
  };
}

/** 一份只填断言需要字段的输入。 */
function input(fixture: Fixture, over: Partial<CollectAgentTreeInput> = {}): CollectAgentTreeInput {
  return {
    rootId: fixture.root,
    agents: fixture.agents,
    sessions: { get: (id) => fixture.sessions.get(id) },
    projections: fixture.projections,
    sampledMs: SAMPLED_MS,
    ...over,
  };
}

describe('collectAgentTree', () => {
  it('answers the root alone when the session has no children', () => {
    const read = collectAgentTree(
      input(tree({ parents: { [ROOT]: undefined }, status: { [ROOT]: 'running' } }))
    );
    // 根的 `seenAt` 来自会话自己的 header（子级的来自 catalog 条目）。
    expect(read.nodes).toEqual([
      { id: ROOT, kind: 'main', depth: 0, label: 'main', running: true, seenAt: 5 },
    ]);
    expect(read.counts).toEqual({ total: 1, running: 1, unsupported: 0 });
    expect(read.warnings).toBeUndefined();
  });

  // 树的形状来自父会话的 catalog（持久事实），存活度来自 agent 注册表：两者不是一件事，
  // 所以已结束的子代理仍然在树上，只是 `running: false`。
  it('keeps a settled child in the tree while reporting it as not running', () => {
    const read = collectAgentTree(
      input(
        tree({
          parents: { [ROOT]: undefined, 'child-1': ROOT },
          status: { [ROOT]: 'idle' },
          catalogs: {
            [ROOT]: [{ id: 'child-1', createdAt: 7, mode: 'one-shot', label: '审 tests' }],
          },
        })
      )
    );
    expect(read.nodes).toEqual([
      { id: ROOT, kind: 'main', depth: 0, label: 'main', running: false, seenAt: 5 },
      {
        id: 'child-1',
        kind: 'subagent',
        parent: ROOT,
        depth: 1,
        label: '审 tests',
        mode: 'one-shot',
        running: false,
        seenAt: 7,
      },
    ]);
    expect(read.counts).toEqual({ total: 2, running: 0, unsupported: 0 });
  });

  // 两级委派（dev → test）：孙节点的 `parent` 是**子会话**而不是根，这正是「不靠猜」的证明。
  it('links a grandchild to its own parent, not to the root', () => {
    const read = collectAgentTree(
      input(
        tree({
          parents: { [ROOT]: undefined, dev: ROOT, test: 'dev' },
          status: { [ROOT]: 'idle', dev: 'idle', test: 'running' },
          catalogs: {
            [ROOT]: [{ id: 'dev', mode: 'one-shot', label: '写实现' }],
            dev: [{ id: 'test', mode: 'one-shot', label: '跑测试' }],
          },
        })
      )
    );
    expect(read.nodes.map((node) => [node.id, node.depth, node.parent ?? '-'])).toEqual([
      [ROOT, 0, '-'],
      ['dev', 1, ROOT],
      ['test', 2, 'dev'],
    ]);
    expect(read.counts).toEqual({ total: 3, running: 1, unsupported: 0 });
  });

  // 兄弟顺序 = catalog 事件顺序，且先序（父先于子）：面板直接按数组顺序排版。
  it('keeps catalog order for siblings and stays pre-order', () => {
    const read = collectAgentTree(
      input(
        tree({
          parents: { [ROOT]: undefined, a: ROOT, b: ROOT, 'a-child': 'a' },
          catalogs: {
            [ROOT]: [
              { id: 'b', mode: 'one-shot', label: '第二' },
              { id: 'a', mode: 'one-shot', label: '第一' },
            ],
            a: [{ id: 'a-child', mode: 'one-shot', label: 'a 的子级' }],
          },
        })
      )
    );
    expect(read.nodes.map((node) => node.id)).toEqual([ROOT, 'b', 'a', 'a-child']);
  });

  it('falls back to the short id when the catalog carries no label', () => {
    const long = '1234567890abcdef';
    const read = collectAgentTree(
      input(
        tree({
          parents: { [ROOT]: undefined, [long]: ROOT },
          catalogs: { [ROOT]: [{ id: long, mode: 'one-shot' }] },
        })
      )
    );
    expect(read.nodes[1]?.label).toBe('12345678');
    expect(read.nodes[1]?.mode).toBe('one-shot');
  });

  // 一条 id 出现两次（同一子代理被两处登记）只画一次：重复会在面板上变成两行假节点。
  it('visits each session once even when two catalogs name it', () => {
    const read = collectAgentTree(
      input(
        tree({
          parents: { [ROOT]: undefined, a: ROOT },
          catalogs: {
            [ROOT]: [
              { id: 'a', mode: 'one-shot', label: 'a' },
              { id: 'a', mode: 'one-shot', label: 'a 再来一次' },
            ],
            // 人为的环：a 的 catalog 又说自己是根的子级。
            a: [{ id: ROOT, mode: 'one-shot', label: 'root' }],
          },
        })
      )
    );
    expect(read.nodes.map((node) => node.id)).toEqual([ROOT, 'a']);
  });

  // `mode: 'unknown'` 的条目按宿主自己的语义不画（连形态都还没确定），但要有计数，
  // 否则面板会把「有东西没显示」读成「什么都没有」。
  it('drops unsupported catalog entries and counts them', () => {
    const read = collectAgentTree(
      input(
        tree({
          parents: { [ROOT]: undefined, 'ok-1': ROOT },
          catalogs: {
            [ROOT]: [
              { id: 'unknown-1', mode: 'unknown' },
              { id: 'ok-1', mode: 'one-shot', label: '能画的' },
              'not an object',
              { mode: 'one-shot' },
            ],
          },
        })
      )
    );
    expect(read.nodes.map((node) => node.id)).toEqual([ROOT, 'ok-1']);
    expect(read.counts.unsupported).toBe(1);
  });

  // 会话读不出来的子级仍然画（catalog 是持久事实），只是没有读数、也没有下一层。
  it('keeps a child whose session is gone, without metrics or children', () => {
    const read = collectAgentTree(
      input(
        tree({
          parents: { [ROOT]: undefined },
          catalogs: { [ROOT]: [{ id: 'gone', mode: 'continuable', label: '已经收尾的' }] },
        })
      )
    );
    expect(read.nodes[1]).toEqual({
      id: 'gone',
      kind: 'subagent',
      parent: ROOT,
      depth: 1,
      label: '已经收尾的',
      mode: 'continuable',
      running: false,
    });
  });

  it('degrades to the root alone when the catalog key is not registered', () => {
    const read = collectAgentTree(
      input(tree({ parents: { [ROOT]: undefined } }), {
        projections: { stateOf: () => undefined },
      })
    );
    expect(read.nodes).toHaveLength(1);
    expect(read.counts.unsupported).toBe(0);
  });

  // 一个坏分支（`stateOf` 抛错）只丢它自己：根照旧、兄弟照旧，绝不带走整棵树。
  it('loses only the branch whose catalog read throws', () => {
    const fixture = tree({
      parents: { [ROOT]: undefined, bad: ROOT, good: ROOT },
      catalogs: {
        [ROOT]: [
          { id: 'bad', mode: 'one-shot', label: '坏' },
          { id: 'good', mode: 'one-shot', label: '好' },
        ],
      },
    });
    const bad = fixture.sessions.get('bad');
    const read = collectAgentTree(
      input(fixture, {
        projections: {
          stateOf: (s, key) => {
            if (key !== 'subagentCatalog') return undefined;
            if (s === bad) throw new Error('unknown session');
            return fixture.projections.stateOf(s, key);
          },
        },
      })
    );
    expect(read.nodes.map((node) => node.id)).toEqual([ROOT, 'bad', 'good']);
  });

  // 根不在册（面板活得比会话久）不是错误：空树 + 一条说明，由面板显示空态。
  it('answers an empty tree when the root session is not live', () => {
    const read = collectAgentTree(
      input(tree({ parents: {} }), {
        agents: { get: () => undefined },
        sessions: { get: () => undefined },
      })
    );
    expect(read.nodes).toEqual([]);
    expect(read.counts).toEqual({ total: 0, running: 0, unsupported: 0 });
    expect(read.warnings).toEqual(['root session is not live']);
  });

  it('answers an empty tree when neither registry service is present', () => {
    const read = collectAgentTree(
      input(tree({ parents: { [ROOT]: undefined } }), {
        agents: undefined,
        sessions: undefined,
        projections: undefined,
      })
    );
    expect(read.nodes).toEqual([]);
    expect(read.warnings).toEqual(['host agents/sessions services are absent']);
  });

  // 存活度只认 agent 注册表：会话还在册（`sessions.get` 有值）但 agent 已经放掉，
  // 就该读成「不在跑」——catalog 是历史事实，存活度是此刻的事实。
  it('reads a session with no live agent as not running', () => {
    const fixture = tree({ parents: { [ROOT]: undefined } });
    const read = collectAgentTree(input(fixture, { agents: { get: () => undefined } }));
    expect(read.nodes[0]?.running).toBe(false);
  });

  // 上下文/时长等读数来自 `nodeMetrics`：这里只钉「main 不发 token 计数、子级发」，
  // 四桶与降级的细节由 dag-metrics 自己的用例守。catalog 仍由 fixture 提供，投影服务
  // 只在其余键上补料——树的形状与读数是两条独立的读。
  it('withholds token counts for main but publishes them for a subagent', () => {
    const usage = {
      totals: {
        uncachedInputTokens: 10,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    };
    const fixture = tree({
      parents: { [ROOT]: undefined, child: ROOT },
      status: { [ROOT]: 'running', child: 'running' },
      catalogs: { [ROOT]: [{ id: 'child', mode: 'one-shot', label: '子' }] },
    });
    const read = collectAgentTree(
      input(fixture, {
        projections: {
          stateOf: (s, key) => {
            if (key === 'tokenUsage') return usage;
            if (key === 'contextPressure') return { pressureTokens: 900 };
            if (key === 'subagentTiming') return { settledMs: 42 };
            return fixture.projections.stateOf(s, key);
          },
        },
      })
    );
    expect(read.nodes[0]?.metrics).toEqual({ context: 900, elapsed_ms: 42 });
    expect(read.nodes[1]?.metrics).toEqual({
      tokens: 11,
      uncached_input: 10,
      cache_read: 0,
      cache_write: 0,
      output: 1,
      context: 900,
      elapsed_ms: 42,
    });
  });

  // 上限护栏：坏 catalog 造出的超深链被截断，而不是把一次应答变成没完没了的遍历。
  it('stops walking past the depth cap', () => {
    const parents: Record<string, string | undefined> = { [ROOT]: undefined };
    const catalogs: Record<string, readonly unknown[]> = {};
    let previous = ROOT;
    for (let index = 0; index < 12; index += 1) {
      const id = `n-${String(index)}`;
      parents[id] = previous;
      catalogs[previous] = [{ id, mode: 'one-shot', label: id }];
      previous = id;
    }
    const read = collectAgentTree(input(tree({ parents, catalogs })));
    expect(read.nodes).toHaveLength(9);
    expect(read.nodes.at(-1)?.depth).toBe(8);
  });
});
