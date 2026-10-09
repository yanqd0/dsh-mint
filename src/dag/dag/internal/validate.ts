/**
 * DAG 写入前的形状校验：id、label、title、note、计数、worktree 记录。
 *
 * 全部是「拿到当前文档前就能判」的规则；图规则（未知依赖、成环、节点上限）
 * 在 `write.ts` 的 `applyDagWrite`，因为只有那里同时看得见新节点与存盘节点。
 */
import { isRecord } from '../../../mint/mint-json.js';
import type { DagWorktree, DagWorktreeState } from '../../../shared/records.js';
import { hasControlCharacter } from '../../../shared/text.js';
import {
  DAG_LABEL_MAX,
  DAG_NOTE_MAX,
  DAG_PHASES,
  DAG_STATUSES,
  DAG_TITLE_MAX,
  DAG_VERDICTS,
  DAG_WORKTREE_STATES,
  NODE_ID_MAX,
  NODE_ID_SHAPE,
  type DagPhase,
  type DagStatus,
  type DagVerdict,
} from './model.js';

export function codePoints(text: string): number {
  return Array.from(text).length;
}

/**
 * Byte length without a Node builtin.
 *
 * The Node-only byte-length global is unavailable in the browser bundle, and
 * this module ships into it; `TextEncoder` exists in both realms, so one
 * implementation serves both.
 */
export function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function isDagPhase(value: unknown): value is DagPhase {
  return typeof value === 'string' && (DAG_PHASES as readonly string[]).includes(value);
}

export function isDagStatus(value: unknown): value is DagStatus {
  return typeof value === 'string' && (DAG_STATUSES as readonly string[]).includes(value);
}

export function isDagVerdict(value: unknown): value is DagVerdict {
  return typeof value === 'string' && (DAG_VERDICTS as readonly string[]).includes(value);
}

/**
 * 节点 id 的唯一校验口（写路径与读路径共用）。
 *
 * 它管的不是「文档里干净」这一件事：`node.id` 会被拼进 merge commit 的 subject、
 * worktree 的分支名、以及 worktree 落在 `git common dir` 下的路径段。于是 id 的
 * 取值面就是那条「上库内容不得出现 mint ID」不变量的另一半——守卫扫的是源码文本，
 * 扫不到运行期拼进去的字符串。控制字符由字符集一并挡住，故不再单独判。
 *
 * 收紧的代价在读路径上：存量含非法 id 的文档会整份判为不可读（fail-loud，错误里
 * 带那个 id），而不是悄悄丢掉那个节点——文档只在 `/tmp`，改 JSON 或 `init` 重建
 * 即可，静默丢节点才是不可接受的。
 *
 * 导出是因为独立 `worktree` 工具要校验同一个 `node` 参数：一处规则，不回抄。
 */
export function checkNodeId(raw: unknown): string | { error: string } {
  if (typeof raw !== 'string' || raw.length === 0) return { error: '节点 id 必须是非空字符串' };
  if (codePoints(raw) > NODE_ID_MAX) return { error: `节点 id 过长（>${String(NODE_ID_MAX)} 字）` };
  if (!NODE_ID_SHAPE.test(raw)) {
    return { error: `节点 id 只允许 [A-Za-z0-9._-] 且首字符须字母或数字：${JSON.stringify(raw)}` };
  }
  return raw;
}

export function checkLabel(raw: unknown): string | { error: string } {
  if (typeof raw !== 'string' || raw.length === 0) return { error: 'label 必须是非空字符串' };
  if (codePoints(raw) > DAG_LABEL_MAX) {
    return { error: `label 超过 ${String(DAG_LABEL_MAX)} 字：${JSON.stringify(raw)}` };
  }
  if (hasControlCharacter(raw)) return { error: `label 含控制字符：${JSON.stringify(raw)}` };
  return raw;
}

export function checkTitle(raw: unknown): string | { error: string } {
  if (typeof raw !== 'string' || raw.length === 0) return { error: 'title 必须是非空字符串' };
  if (codePoints(raw) > DAG_TITLE_MAX) {
    return { error: `title 超过 ${String(DAG_TITLE_MAX)} 字` };
  }
  return raw;
}

export function checkNote(raw: unknown): string | { error: string } {
  if (typeof raw !== 'string') return { error: 'note 必须是字符串' };
  if (utf8Length(raw) > DAG_NOTE_MAX) {
    return { error: `note 超过 ${String(DAG_NOTE_MAX)} 字节` };
  }
  return raw;
}

export function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function checkCount(raw: unknown, name: string): number | { error: string } {
  if (!isCount(raw)) return { error: `${name} 必须是非负整数` };
  return raw;
}

export function isDagWorktreeState(value: unknown): value is DagWorktreeState {
  return typeof value === 'string' && (DAG_WORKTREE_STATES as readonly string[]).includes(value);
}

/**
 * One node's worktree record.
 *
 * Strict on read and on write for the same reason the rest of this module is: a
 * path or branch the panel would print is either a plain string this host wrote
 * or it is not data worth keeping. Empty strings are refused because they would
 * render as a blank line where a path belongs.
 *
 * `target` 是可选字段：早期版本的节点没有它，缺省必须可读；但一旦出现
 * 就按同一标准校验。
 */
export function checkWorktree(raw: unknown, where: string): DagWorktree | { error: string } {
  if (!isRecord(raw)) return { error: `${where}: worktree 必须是对象` };
  for (const field of ['path', 'branch', 'base'] as const) {
    const value = raw[field];
    if (typeof value !== 'string' || value.length === 0) {
      return { error: `${where}: worktree.${field} 必须是非空字符串` };
    }
    if (hasControlCharacter(value)) return { error: `${where}: worktree.${field} 含控制字符` };
  }
  if (!isDagWorktreeState(raw.state)) {
    return { error: `${where}: worktree.state 必须是 ${DAG_WORKTREE_STATES.join(' | ')}` };
  }
  if (raw.merged_sha !== undefined && typeof raw.merged_sha !== 'string') {
    return { error: `${where}: worktree.merged_sha 必须是字符串` };
  }
  // target 可选（旧节点没有这条记录，见 `DagWorktree.target`）：存在时必须是真分支
  // 名，空串会渲染成空白、控制字符会破坏行格式。
  if (raw.target !== undefined && (typeof raw.target !== 'string' || raw.target.length === 0)) {
    return { error: `${where}: worktree.target 必须是非空字符串` };
  }
  if (typeof raw.target === 'string' && hasControlCharacter(raw.target)) {
    return { error: `${where}: worktree.target 含控制字符` };
  }
  return {
    path: raw.path as string,
    branch: raw.branch as string,
    base: raw.base as string,
    state: raw.state,
    ...(raw.merged_sha === undefined ? {} : { merged_sha: raw.merged_sha }),
    ...(raw.target === undefined ? {} : { target: raw.target }),
  };
}

export function checkEdge(raw: unknown): [string, string] | { error: string } {
  if (!Array.isArray(raw) || raw.length !== 2) return { error: 'edges 的每一项必须是 [from, to]' };
  const [from, to] = raw as [unknown, unknown];
  if (typeof from !== 'string' || from.length === 0 || typeof to !== 'string' || to.length === 0) {
    return { error: 'edges 的 from/to 必须是非空字符串' };
  }
  return [from, to];
}
