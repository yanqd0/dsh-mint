/**
 * 子代理树文档的文件层：`/tmp/mint/agents/<sessionId>.json`。
 *
 * 与 `dag-store.ts` 同形态，**刻意不共享实现**：那边的原子替换、每会话一把锁、三态读取是
 * DAG 的既有契约，从这里去改它的导出只会把两件事绑在一起；本文件复刻一份最小实现，代价是几十
 * 行，换来的是两条文档各自能改。两条规则本身仍然一样：
 *
 * - **原子替换**：先写同目录临时文件再 `rename`，读者永远看不到半份文档。
 * - **每会话一把锁**：写是跨进程的读-改-写，同一个会话的两次写串在一条 promise 链上。
 *
 * 与 DAG 的差别在**寿命**：DAG 是活计划的视图，本文件是**会话结束后的兜底快照**——子代理
 * 树一旦读不到（会话离场、宿主重启），面板仍能照这份文件画出最后一棵树。因此它也住在 `/tmp`，
 * 重启清掉是容忍的正常态，面板退回空态。
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { isValidDagSession } from '../dag.js';
import { parseAgentTreeDoc } from './internal/parse-doc.js';
import type { AgentTreeDoc } from './internal/parse-doc.js';

/** 子代理树文档的目录；与 `DAG_DIR` 并列，理由相同（见文件头）。 */
export const AGENT_TREE_DIR = '/tmp/mint/agents';

/** 一个不能当路径段的会话 id。 */
export class AgentTreePathError extends Error {}

/** 一份文档的路径。id 在拼接之前就在这里校验过。 */
export function agentTreeFilePath(sessionId: string, dir: string = AGENT_TREE_DIR): string {
  if (!isValidDagSession(sessionId)) {
    throw new AgentTreePathError(`invalid agent tree session id: ${JSON.stringify(sessionId)}`);
  }
  return join(dir, `${sessionId}.json`);
}

export type AgentTreeFileRead =
  | { state: 'missing'; file: string }
  | { state: 'ok'; file: string; doc: AgentTreeDoc }
  | { state: 'unreadable'; file: string; error: string };

function isMissing(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'ENOENT';
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 读一个会话的文档。
 *
 * 文件缺失是**正常**答案（`state: 'missing'`），不是错误：多数会话从没有过子代理，路由把它答成
 * 空树。不可读才有内容——坏 JSON、校验失败，或文档里的会话 id 与请求的不是同一个（后者说明这
 * 个文件被别的东西写坏了，绝不能拿它冒充本会话的树）。
 */
export async function readAgentTreeDoc(
  sessionId: string,
  dir: string = AGENT_TREE_DIR
): Promise<AgentTreeFileRead> {
  const file = agentTreeFilePath(sessionId, dir);
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (isMissing(error)) return { state: 'missing', file };
    return { state: 'unreadable', file, error: messageOf(error) };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { state: 'unreadable', file, error: `invalid JSON: ${messageOf(error)}` };
  }
  const parsed = parseAgentTreeDoc(raw);
  if ('error' in parsed) return { state: 'unreadable', file, error: parsed.error };
  if (parsed.doc.session !== sessionId) {
    return {
      state: 'unreadable',
      file,
      error: `document belongs to session ${parsed.doc.session}`,
    };
  }
  return { state: 'ok', file, doc: parsed.doc };
}

/**
 * 一次加锁的读-改-写决定什么。
 *
 * `skip` 是「没什么可做」（新读数与已存快照逐字段相同，重写只会让面板重渲）；`error` 是调用方
 * 要报告的拒绝；其余就是要落盘的文档。
 */
export type AgentTreeMutation = (
  state: AgentTreeFileRead
) => { doc: AgentTreeDoc } | { skip: true } | { error: string };

export type AgentTreeUpdate =
  { ok: true; doc: AgentTreeDoc } | { ok: true; skipped: true } | { ok: false; error: string };

/** 每个会话的在途写，让第二次写排到第一次落地之后。 */
const locks = new Map<string, Promise<unknown>>();

/**
 * 把 `task` 接在该会话已排队的每一次写之后。
 *
 * 表里存的是**已结算**的延续而不是任务本身：被拒的任务因此不会毒化下一次，链排空后条目自动
 * 消失（插件寿命很长，无界 map 不是）。
 */
function withLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  const run = previous.then(task, task);
  const settle = (): void => {
    if (locks.get(key) === settled) locks.delete(key);
  };
  const settled = run.then(settle, settle);
  locks.set(key, settled);
  return run;
}

async function writeAtomic(file: string, doc: AgentTreeDoc): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${String(process.pid)}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(doc, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await rename(temporary, file);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

/** 读-改-写一份文档：锁、现读、由 `mutate` 裁决、原子落盘。 */
export async function updateAgentTree(
  sessionId: string,
  mutate: AgentTreeMutation,
  dir: string = AGENT_TREE_DIR
): Promise<AgentTreeUpdate> {
  const file = agentTreeFilePath(sessionId, dir);
  return withLock(file, async (): Promise<AgentTreeUpdate> => {
    const state = await readAgentTreeDoc(sessionId, dir);
    const decision = mutate(state);
    if ('skip' in decision) return { ok: true, skipped: true };
    if ('error' in decision) return { ok: false, error: decision.error };
    try {
      await writeAtomic(file, decision.doc);
    } catch (error) {
      return { ok: false, error: `写入子代理树失败：${messageOf(error)}` };
    }
    return { ok: true, doc: decision.doc };
  });
}

/** 文档版本号随解析层再出一次：快照组装处只 import 本模块就够。 */
export { AGENT_TREE_VERSION } from './internal/parse-doc.js';
