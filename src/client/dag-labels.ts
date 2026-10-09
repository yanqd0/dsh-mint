/**
 * 节点枚举值的文案：工具与面板共享 mint 自己的词汇。
 *
 * 枚举值在两种语言里都保持英文（`research`/`exec`、`pass`/`fail`…），逐个 `switch`
 * 是为了让每个 `dag.*` key 都是字面量——字典的「每个 key 都被问到」守卫是文本匹配。
 */
import type { DagNodeView, DagVerdict, DagWorktreeState } from '../shared/records.js';
import type { MintBodyProps } from './types.js';

export function phaseLabel(copy: MintBodyProps['copy'], phase: DagNodeView['phase']): string {
  switch (phase) {
    case 'research':
      return copy('dag.phase.research');
    case 'exec':
      return copy('dag.phase.exec');
  }
}

/** As {@link phaseLabel}, for a node's lifecycle state. */
export function statusLabel(copy: MintBodyProps['copy'], status: DagNodeView['status']): string {
  switch (status) {
    case 'pending':
      return copy('dag.status.pending');
    case 'running':
      return copy('dag.status.running');
    case 'done':
      return copy('dag.status.done');
  }
}

/** As {@link phaseLabel}, for a settled node's outcome. */
export function verdictLabel(copy: MintBodyProps['copy'], verdict: DagVerdict): string {
  switch (verdict) {
    case 'pass':
      return copy('dag.verdict.pass');
    case 'fail':
      return copy('dag.verdict.fail');
  }
}

/** As {@link phaseLabel}, for the state of a node's isolated working tree. */
export function worktreeStateLabel(copy: MintBodyProps['copy'], state: DagWorktreeState): string {
  switch (state) {
    case 'active':
      return copy('dag.worktree.state.active');
    case 'merged':
      return copy('dag.worktree.state.merged');
    case 'conflict':
      return copy('dag.worktree.state.conflict');
    case 'removed':
      return copy('dag.worktree.state.removed');
  }
}
