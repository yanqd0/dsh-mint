/**
 * DAG 文档的形状：版本与上限常量、线格式类型。
 *
 * 纯数据与纯类型——**没有任何 import 副作用**，因此浏览器半边
 * （`src/client/dag-model.ts`）可以放心内联这一族模块。
 */
import type {
  DagNodeView,
  DagPhase,
  DagStatus,
  DagVerdict,
  DagView,
  DagWorktree,
  DagWorktreeState,
} from '../../../shared/records.js';

/** 文档形状用到的枚举类型，转出去以免调用方为同样的名字多导一遍 records。 */
export type { DagPhase, DagStatus, DagVerdict, DagWorktree, DagWorktreeState };

/** The only document version this build reads or writes. */
export const DAG_VERSION = 1;

/** A node label is drawn inside the box; six code points is the panel's budget. */
export const DAG_LABEL_MAX = 6;

/** A node title is the tooltip's headline; long enough, still bounded. */
export const DAG_TITLE_MAX = 200;

/** A node's conclusion text is quoted verbatim; bounded so one read stays cheap. */
export const DAG_NOTE_MAX = 16 * 1024;

/** A document is a plan's shape, not a log; past this it is a modelling error. */
export const DAG_NODE_MAX = 200;

/** An id travels in a URL and in a path segment; this is the only accepted shape. */
const SESSION_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Node ids are referenced by other nodes, so they stay short and unpunctuated. */
export const NODE_ID_MAX = 64;

/**
 * 节点 id 的形状：只认这一种，读路径与写路径共用。
 *
 * 与 `SESSION_ID` 同源的理由——id 会进 URL 与路径段；这里更硬，因为 `node.id`
 * 还被拼进**上库内容与 git 引用**：merge commit 的 subject、worktree 的分支名、
 * 以及它落在 `git common dir` 下的路径段。所以这一条正则同时挡住三类东西：
 * ① `#<数字>`（上库内容不得出现 mint ID）；② 空白 / `/` / `\` / 控制字符（git ref
 * 的禁区）；③ 以 `.` 开头的 `.` / `..`（会让路径段逃出会话目录）。
 */
export const NODE_ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** A subagent session id, as backfilled by the host's lifecycle pairing. */
export const AGENT_ID_MAX = 128;

export const DOC_TITLE_MAX = 200;

export const DAG_PHASES: readonly DagPhase[] = ['research', 'exec'];
export const DAG_STATUSES: readonly DagStatus[] = ['pending', 'running', 'done'];
export const DAG_VERDICTS: readonly DagVerdict[] = ['pass', 'fail'];

/** True for a session id safe to use as a path segment (never concatenate first). */
export function isValidDagSession(id: string): boolean {
  return SESSION_ID.test(id);
}

export type DagNode = DagNodeView;

/**
 * One node's persisted host measurement (`samples[id]`): what the panel falls
 * back to once the child session is gone. Not the node's self-reported `tokens`.
 */
export interface DagSample {
  tokens?: number;
  elapsed_ms?: number;
  at: number;
}

/**
 * The stored document: {@link DagView} plus the fields that only make sense on
 * disk (the version that gates reading, and the session that owns the file).
 */
export interface DagDoc extends DagView {
  version: typeof DAG_VERSION;
  session: string;
  /**
   * Host-measured samples, keyed by node id.
   *
   * Nothing in this module writes it: this batch only **reads and validates** it
   * (see {@link parseDagDoc} / {@link sampleOf}), and `applyDagWrite` keeps
   * whatever the current document already carries because it spreads it. The
   * fallback persistence belongs to the lifecycle and merges into this key
   * through `updateDag`, so a writer must merge by hand instead of expecting an
   * action here to produce `samples`.
   */
  samples?: Record<string, DagSample>;
}

/** A node as `add` supplies it; `status`/`updated_at` are the host's. */
export interface DagAddNode {
  id: string;
  label: string;
  title: string;
  phase: DagPhase;
  depends_on: string[];
  issue?: number;
}

export const DAG_WORKTREE_STATES: readonly DagWorktreeState[] = [
  'active',
  'merged',
  'conflict',
  'removed',
];

export type DagAction =
  | { action: 'init'; title: string }
  | { action: 'add'; nodes: DagAddNode[]; edges: [string, string][] }
  | {
      action: 'set';
      id: string;
      status: DagStatus;
      verdict?: DagVerdict;
      note?: string;
      tokens?: number;
      agent?: string;
      /** Persisted by the worktree tool; an ordinary `set` leaves it alone. */
      worktree?: DagWorktree;
    }
  | { action: 'get' };

/**
 * The actions that write a document.
 *
 * The worktree actions are absent on purpose: they change the **filesystem**
 * (git worktrees) and live in the standalone `worktree` tool, which persists the
 * resulting node state as a follow-up `set`, so a failed git command never
 * leaves a claim in the document.
 */
export type DagWrite = Extract<DagAction, { action: 'init' | 'add' | 'set' }>;

export type DagResult = { doc: DagDoc } | { error: string };

export interface DagCounts {
  nodes: number;
  edges: number;
  pending: number;
  running: number;
  done: number;
}
