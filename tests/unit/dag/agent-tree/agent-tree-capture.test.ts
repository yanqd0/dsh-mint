import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { installAgentTreeCapture } from '../../../../src/dag/agent-tree/agent-tree-capture.js';
import { readAgentTreeDoc } from '../../../../src/dag/agent-tree/agent-tree-store.js';
import type { AgentTreeDoc } from '../../../../src/dag/agent-tree/internal/parse-doc.js';
import type { DshContext } from '../../../../src/shared/types.js';

/**
 * 子代理树快照的**事件抓拍**：`subagent/start` / `subagent/end` 到来时给链上每个会话落一份文档。
 *
 * 每个用例一个 `tmpdir` 目录（默认目录是 `/tmp/mint/agents`，写进去会覆盖真实会话的快照），
 * 落盘是 fire-and-forget，所以先 `drain()` 排空队列，再用真 store 读回文档——这也是唯一能证明
 * 「写了什么、写了几份」的方式。
 */
const ROOT = 'root';
const CHILD = 'child';
const MID = 'mid';
const GRAND = 'grand';
const CREATED_AT = 5;

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mint-agent-tree-capture-'));
  dirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** 落盘排在 `updateAgentTree` 的每会话锁上：排空 20 轮宏任务足够它跑完。 */
async function drain(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

/** 读回一份**必定存在**的文档；缺失即用例失败，顺带给返回类型收窄。 */
async function readDoc(sessionId: string, dir: string): Promise<AgentTreeDoc> {
  const read = await readAgentTreeDoc(sessionId, dir);
  expect(read.state).toBe('ok');
  if (read.state !== 'ok') throw new Error(`no agent tree document for ${sessionId}`);
  return read.doc;
}

interface Harness {
  start: (info: { runId: string; id: string }) => void;
  end: (info: { runId: string; id: string }) => void;
  /** 每个会话的直接父；键**在册**即「注册表认得这个会话」。 */
  parents: Map<string, string | undefined>;
  status: Map<string, string>;
  catalogs: Map<string, readonly unknown[]>;
  /** 让 `get('agents')` 整体缺席，模拟精简组合。 */
  withoutAgents: () => void;
  /** 让 `agents.get` 抛错，模拟宿主形状漂移。 */
  breakAgents: () => void;
}

/**
 * 捕获监听器的假 ctx：三个宿主服务各自独立，于是「没有父」「服务缺席」「注册表抛错」可分。
 */
function harness(dir: string): Harness {
  const listeners: Record<string, (info: never) => void> = {};
  const parents = new Map<string, string | undefined>();
  const status = new Map<string, string>();
  const catalogs = new Map<string, readonly unknown[]>();
  let agentsService = true;
  let broken = false;
  const session = (id: string): { id: string; header: Record<string, unknown> } => {
    const parent = parents.get(id);
    return {
      id,
      header: {
        id,
        createdAt: CREATED_AT,
        ...(parent === undefined ? {} : { parentSession: parent }),
      },
    };
  };
  const ctx: DshContext = {
    on: (event, listener) => {
      listeners[event] = listener as (info: never) => void;
      return () => {};
    },
    get: (name) => {
      if (name === 'agents') {
        if (!agentsService) return undefined;
        return {
          get: (id: string) => {
            if (broken) throw new Error('registry is gone');
            if (!parents.has(id)) return undefined;
            const value = status.get(id);
            return { id, session: session(id), ...(value === undefined ? {} : { status: value }) };
          },
        };
      }
      if (name === 'sessions') {
        return { get: (id: string) => (parents.has(id) ? session(id) : undefined) };
      }
      if (name === 'sessionProjections') {
        return {
          stateOf: (value: unknown, key: string): unknown =>
            key === 'subagentCatalog'
              ? catalogs.get((value as { id?: string }).id ?? '')
              : undefined,
        };
      }
      return undefined;
    },
  };
  installAgentTreeCapture(ctx, dir);
  return {
    start: (info) => listeners['subagent/start']?.(info as never),
    end: (info) => listeners['subagent/end']?.(info as never),
    parents,
    status,
    catalogs,
    withoutAgents: () => {
      agentsService = false;
    },
    breakAgents: () => {
      broken = true;
    },
  };
}

/** 一级委派的现成场景：`CHILD` 的直接父是 `ROOT`，catalog 里挂着它。 */
function firstLevel(dir: string): Harness {
  const events = harness(dir);
  events.parents.set(ROOT, undefined);
  events.parents.set(CHILD, ROOT);
  events.status.set(ROOT, 'running');
  events.status.set(CHILD, 'running');
  events.catalogs.set(ROOT, [{ id: CHILD, createdAt: 7, mode: 'one-shot', label: '审 tests' }]);
  return events;
}

describe('installAgentTreeCapture', () => {
  it('writes the parent session document on a first-level delegation', async () => {
    const dir = tempDir();
    const events = firstLevel(dir);
    events.start({ runId: 'r1', id: CHILD });
    await drain();
    const doc = await readDoc(ROOT, dir);
    expect(doc.revision).toBe(1);
    expect(doc.nodes).toHaveLength(2);
    expect(doc.nodes[1]).toMatchObject({
      id: CHILD,
      kind: 'subagent',
      parent: ROOT,
      label: '审 tests',
      running: true,
    });
  });

  // 起止配对：`end` 带来 `running: false`，那是树的真变化，`revision` 该前进；再发一次一模一样的
  // `end` 什么都没变，`revision` 必须停住（面板的重渲守卫就据此跳过）。
  it('advances the revision once on end and keeps it on a repeated end', async () => {
    const dir = tempDir();
    const events = firstLevel(dir);
    events.start({ runId: 'r1', id: CHILD });
    await drain();
    const started = await readDoc(ROOT, dir);

    events.status.set(CHILD, 'idle');
    events.end({ runId: 'r1', id: CHILD });
    await drain();
    const settled = await readDoc(ROOT, dir);
    expect(settled.revision).toBe(started.revision + 1);
    expect(settled.nodes[1]?.running).toBe(false);

    events.end({ runId: 'r1', id: CHILD });
    await drain();
    expect((await readDoc(ROOT, dir)).revision).toBe(settled.revision);
  });

  // 两级委派：孙代理的直接父是中间子代理，所以链上两份文档都要有——`mid.json` 是它自己那棵树，
  // `root.json` 是把 `mid` 当子级、`grand` 当孙级的那棵。
  it('writes one document per readable ancestor on a two-level chain', async () => {
    const dir = tempDir();
    const events = harness(dir);
    events.parents.set(ROOT, undefined);
    events.parents.set(MID, ROOT);
    events.parents.set(GRAND, MID);
    events.status.set(MID, 'running');
    events.status.set(GRAND, 'running');
    events.catalogs.set(ROOT, [{ id: MID, createdAt: 7, mode: 'continuable' }]);
    events.catalogs.set(MID, [{ id: GRAND, createdAt: 9, mode: 'one-shot' }]);
    events.start({ runId: 'r2', id: GRAND });
    await drain();
    expect((await readDoc(ROOT, dir)).nodes.map((node) => node.id)).toEqual([ROOT, MID, GRAND]);
    expect((await readDoc(MID, dir)).nodes.map((node) => node.id)).toEqual([MID, GRAND]);
  });

  // 非法 id 拼不出合法路径：不抛、也不写任何文件。
  it.each(['', 'a/b', 'x'.repeat(65)])('ignores an invalid subagent id %j', async (id) => {
    const dir = tempDir();
    const events = firstLevel(dir);
    expect(() => {
      events.start({ runId: 'r3', id });
    }).not.toThrow();
    await drain();
    expect(readdirSync(dir)).toEqual([]);
  });

  // 链里出现非法 id（注册表答得出、但拼不出合法路径）时只跳过它，上溯不能就此停住：
  // `root` 仍然该留下文档。
  it('skips an invalid ancestor but keeps walking up the chain', async () => {
    const dir = tempDir();
    const events = firstLevel(dir);
    events.parents.set('a/b', ROOT);
    events.parents.set(CHILD, 'a/b');
    events.start({ runId: 'r4', id: CHILD });
    await drain();
    expect(readdirSync(dir)).toEqual([`${ROOT}.json`]);
  });

  it('writes nothing when the host has no agents service', async () => {
    const dir = tempDir();
    const events = firstLevel(dir);
    events.withoutAgents();
    events.start({ runId: 'r5', id: CHILD });
    await drain();
    expect(readdirSync(dir)).toEqual([]);
    expect((await readAgentTreeDoc(ROOT, dir)).state).toBe('missing');
  });

  it('does not throw when the agent registry itself throws', () => {
    const dir = tempDir();
    const events = firstLevel(dir);
    events.breakAgents();
    expect(() => {
      events.start({ runId: 'r6', id: CHILD });
    }).not.toThrow();
  });
});
