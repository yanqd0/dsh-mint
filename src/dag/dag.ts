/**
 * The plan DAG's data layer: document shape, argument validation,
 * cycle detection, and the topological layering the panel draws.
 *
 * Pure data and pure functions only — **no `node:` import**: the browser half
 * inlines this module (`src/client/dag-model.ts`) exactly as it does
 * `route-paths.ts`, so anything reaching for a builtin would break the client
 * bundle. Every filesystem concern lives in `dag-store.ts`.
 *
 * The document the tool owns is `DagDoc` (a `DagView` plus the two ownership
 * fields); the subset the panel receives is declared once in `records.ts`, so
 * the host and the browser cannot drift apart.
 *
 * 文件限大后原地拆目录：本文件保留 `'./dag.js'` 这个公开面，实现按职责放在
 * `internal/`（NodeNext 不解析目录 index，故公开面必须留一个文件）。
 */
export {
  AGENT_ID_MAX,
  DAG_LABEL_MAX,
  DAG_NODE_MAX,
  DAG_NOTE_MAX,
  DAG_PHASES,
  DAG_STATUSES,
  DAG_TITLE_MAX,
  DAG_VERDICTS,
  DAG_VERSION,
  DAG_WORKTREE_STATES,
  DOC_TITLE_MAX,
  NODE_ID_MAX,
  NODE_ID_SHAPE,
  isValidDagSession,
} from './dag/internal/model.js';
export type {
  DagAction,
  DagAddNode,
  DagCounts,
  DagDoc,
  DagNode,
  DagResult,
  DagSample,
  DagWrite,
} from './dag/internal/model.js';
export {
  checkCount,
  checkEdge,
  checkLabel,
  checkNodeId,
  checkNote,
  checkTitle,
  checkWorktree,
  codePoints,
  isCount,
  isDagPhase,
  isDagStatus,
  isDagVerdict,
  isDagWorktreeState,
  utf8Length,
} from './dag/internal/validate.js';
export { parseDagAction } from './dag/internal/parse-action.js';
export { parseDagDoc, sampleOf } from './dag/internal/parse-doc.js';
export { applyDagWrite, emptyDag } from './dag/internal/write.js';
export {
  dagCounts,
  dagLayers,
  dagSummary,
  findCycle,
  unknownDependencies,
} from './dag/internal/graph.js';
