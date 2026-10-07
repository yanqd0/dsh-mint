import { existsSync, readdirSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { MINT_TOOL_GUIDANCE } from '../../src/host/context.js';
import { MINT_TOOL_DESCRIPTION } from '../../src/mint/mint-tool.js';
import { repoPath } from '../helpers/repo.js';

/**
 * Skill layout contracts.
 *
 * The always-loaded skill payload is **SKILL.md alone**: the filesystem
 * provider reads only `<skill>/SKILL.md` and exposes the directory as
 * `resourceBase`, so `references/` cost nothing until the model reads one
 * (`dsh-skill-filesystem` `get()`, checked against 0.2.0). Three contracts are
 * worth pinning:
 *
 * 1. SKILL.md stays a router + gate sheet — the split principle in AGENTS.md
 *    sends branch/standalone content to references, under an explicit budget.
 * 2. Every reference the router names exists, and no reference is orphaned.
 * 3. Mandatory workflow gates survive in SKILL.md; rules that moved keep their
 *    markers in their new home file.
 */
const SKILL_DIR = repoPath('skill');
const REF_DIR = `${SKILL_DIR}/references`;
const read = (name: string): string => readFileSync(`${SKILL_DIR}/${name}`, 'utf8');
const bytes = (text: string): number => Buffer.byteLength(text, 'utf8');

const skill = read('SKILL.md');

/**
 * Reference files SKILL.md names.
 *
 * The router writes paths relative to `references/` (it states that base), so a
 * name counts with or without the prefix — but only when it matches a file that
 * actually exists, which keeps prose like `` `package.json` `` out of the set.
 */
function namedReferences(): Set<string> {
  const onDisk = new Set(readdirSync(REF_DIR).filter((file) => file.endsWith('.md')));
  const named = new Set<string>();
  for (const match of skill.matchAll(/`(?:references\/)?([a-z0-9-]+\.md)`/g)) {
    const file = match[1];
    if (file !== undefined && onDisk.has(file)) named.add(file);
  }
  return named;
}

/** Gates that must never be trimmed out of the always-loaded SKILL.md. */
const SKILL_MARKERS: readonly string[] = [
  'plan 绑定（单向）',
  'exit_plan_mode',
  '记录必须有，顺序可换',
  '"issue","state","start"',
  '"issue","state","commit"',
  'plan close',
  'running milestone',
  '不得自行置 running',
  '须走 bash',
  // reference paths are written relative to `references/` (the router
  // states that base), so the marker pins the pointer, not the prefix.
  '`labels.md`',
  '跨项目登记',
  // the default project is the session cwd, so own-project calls take no
  // `-p`. Pinned as a marker because trimming it re-opens the exact behaviour
  // this plan fixed.
  '本项目操作不带 `-p`',
  // parallel batches are the plan-level constraint that keeps
  // concurrently delegated work off the same files.
  '并行批次',
  // registration never pre-schedules; `plan plan` belongs to the start of
  // work, not to filing the issue.
  '提 issue 一律 open',
  // one milestone carries at most one running plan — the second is refused
  // by the plan-mode exit gate, so the router has to carry the rule.
  '至多一个 running plan',
];

/** Rules that moved out of SKILL.md must still exist in their home file. */
const HOME_MARKERS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['references/template-guide.md', ['- [ ]', 'title-templates/', 'body-templates/']],
  ['references/body-editing.md', ['--body-section', '- [ ]', 'section not found']],
  ['references/constraints.md', ['state drop', 'plan drop', '--force-new']],
  ['references/flow-planning.md', ['dev-clean', 'task', '登记 ≠ 排期', '开工点才', '只有开工点才']],
  ['references/labels.md', ['上限 5 个', '英文', '不主动清理']],
  // a filed requirement stays open; a plan is created only when work actually
  // starts. A freshly created plan (plan mode or not) also stays `open` until
  // the start-of-work point locks it.
  ['references/flow-requirement.md', ['登记一律', '不预建 mint plan', '保持 `open`']],
  // both legal orders (build-then-run / run-then-backfill) live in
  // flow-impl, and the issue ordering rule left SKILL.md's body for the place
  // that already carried it (flow-session's step 4).
  // the batch lock is a start-of-work action, not an attach-time one.
  // the host todo panel is the human's progress view, so the derive/sync
  // discipline has to survive in flow-impl.
  // the binding is one-way and the start-of-work point has two shapes
  // (plan-mode exit / before the first edit outside plan mode).
  [
    'references/flow-impl.md',
    [
      '先跑后建',
      '记录必须有',
      '顺序可换',
      '登记 ≠ 排期',
      '不预建 plan',
      'todo_write',
      '宿主 todo',
      '单向',
      '非计划模式',
      '开工点',
      // the three-condition gate sheet lives in flow-impl (the criterion,
      // the milestone bucket, and the convergence paths for a refusal).
      '至多一个 running plan',
      // locking `planned` at the exit point needs this session to actually
      // start the work; registration-only sessions leave everything `open`.
      '确实要开工',
    ],
  ],
  ['references/flow-session.md', ['priority 升序', '按 id 升序', '单个 issue']],
  // The DAG discipline split into its two halves. `plan-dag` owns the
  // pre-approval research loop (total-split-total, user decisions only at the
  // "totals", injection discipline); `dag-exec` owns the post-approval panorama
  // (layering by the five axes, who runs what, append-no-cycle rework).
  // Delegation goes **two levels** deep: a first-level dev subagent may hire its
  // own read-only test subagent, and the second level hires nobody (host
  // `subagent.maxDepth`). Trimming this re-opens depth guessing for every plan.
  [
    'references/plan-dag.md',
    ['总—分—总', 'ask_user_question', '派子代理', '注入前置纪律', '委派允许两级'],
  ],
  // `dag-exec` owns the graph's *shape*: an edge is a semantic dependency only.
  // Execution order (same-file serialisation, one node at a time, batch order)
  // belongs to the batch table — encoded as edges it degenerates the graph into
  // a line that later readers misread as "everything blocks everything".
  // Rework is a reopen, not a new node: a failed test re-runs its own test node.
  [
    'references/dag-exec.md',
    ['给子代理', '留 main', '五轴', '无环', '执行序不进边', 'reopen 同一个 test 节点重跑'],
  ],
  // the container derivation table now mirrors mint's `derive.rs` — `open`
  // children derive an `open` plan (not `running`), which is the fact the plan
  // gate and the deadlock analysis in the same reference both rest on.
  ['references/state-machine.md', ['全 `open` 的 plan 派生 `open`', 'partial', 'derive.rs']],
  // the parallel-execution contract (batch table, subagent dispatch, no
  // sleeps, state commit) lives in its own reference. It also owns the dev/test
  // node pair — one edge only, `test 依赖 dev`; the sanctioned exception for a
  // plan whose subject *is* the isolation mechanism; and the one channel a
  // subagent may use for a user decision (write it into the final reply —
  // `ask_user_question` is refused for a delegated caller).
  [
    'references/parallel-exec.md',
    [
      '并行批次',
      'subagent',
      '不 sleep',
      'state commit',
      'dev/test 节点对',
      'test 依赖 dev',
      '被改特性本身就是隔离机制',
      '遇用户决策写进最终回复',
      '不要调用 `ask_user_question`',
    ],
  ],
  // A dev/test pair shares **one** tree: `create`/`merge`/`remove` all name the
  // dev node, and both nodes may be `running` at once (the dev subagent
  // dispatches its own test child). A second tree would break the pairing.
  ['references/worktree-exec.md', ['dev/test 节点对只建一棵树', '两节点可同时 `running`']],
  // cross-project registration carries its source, and the tool gate is
  // one confirmation per session and target project — not per call. A subagent
  // has no approval channel at all, so a decision it hits travels back in its
  // final reply and the root agent merges the round's decisions into one
  // question before writing anything. The target project is confirmed first,
  // kind is problem/requirement, the title may stay free of the source, and the
  // report avoids prescribing a fix.
  [
    'references/cross-project.md',
    [
      '--project',
      '来源：',
      '同一会话',
      '子代理',
      'project list',
      '`problem`',
      '`requirement`',
      '不要给具体实现方案',
    ],
  ],
];

describe('skill layout', () => {
  it('keeps the always-loaded body inside the router budget', () => {
    // 6965 B before the split; 3987 B before the reference-split refactor. The
    // ceiling was re-pinned to 3200 B with that refactor (non-mainline sections
    // moved into references), so the always-loaded body pays for gates +
    // routing only.
    expect(bytes(skill)).toBeLessThanOrEqual(3200);
  });

  it.each(SKILL_MARKERS)('keeps the gate marker %s in SKILL.md', (marker) => {
    expect(skill).toContain(marker);
  });

  it('keeps the markers that moved out of SKILL.md in their home file', () => {
    for (const [file, markers] of HOME_MARKERS) {
      expect(existsSync(`${SKILL_DIR}/${file}`), `${file} missing`).toBe(true);
      const text = read(file);
      for (const marker of markers) {
        expect(text, `${file} missing ${marker}`).toContain(marker);
      }
    }
  });

  it('leaves the tool-first policy to the always-on guidance', () => {
    expect(skill).not.toContain('不要用 bash');
    expect(skill).not.toContain('不经 bash');
    expect(MINT_TOOL_DESCRIPTION).not.toContain('不要用 bash');
    expect(MINT_TOOL_DESCRIPTION).not.toContain('不经 bash');
    expect(MINT_TOOL_GUIDANCE).toContain('不经 bash');
  });

  it('names only references that exist', () => {
    expect(namedReferences().size).toBeGreaterThanOrEqual(14);
    for (const file of namedReferences()) {
      expect(existsSync(`${REF_DIR}/${file}`), `${file} missing`).toBe(true);
    }
  });

  it('leaves no orphan reference', () => {
    const named = namedReferences();
    const onDisk = readdirSync(REF_DIR).filter((file) => file.endsWith('.md'));
    for (const file of onDisk) {
      expect(named.has(file), `${file} is not referenced from SKILL.md`).toBe(true);
    }
  });

  it('documents the kebab link value the CLI accepts', () => {
    const commands = read('references/commands.md');
    expect(commands).toContain('"blocked-by"');
    expect(commands).not.toContain('"blocked_by"');
  });

  it('documents the mint 0.8 surface the workflows rely on', () => {
    const commands = read('references/commands.md');
    const tokens = [
      '--force-new',
      '--body-append',
      '--body-section',
      '"plan","drop"',
      '"label","set"',
      '"project","list"',
      '# Page',
    ];
    for (const token of tokens) {
      expect(commands, `commands.md missing ${token}`).toContain(token);
    }
  });

  // the CLI refuses any write that would add a running milestone, and
  // `milestone set --status running --force` is its only escape hatch. The skill
  // has to carry both the read (`current`) and the escape hatch, or a session
  // reasons its way into a rejected command.
  it('documents the single-running guard the workflows rely on', () => {
    const commands = read('references/commands.md');
    const conditions = read('references/flow-conditions.md');
    for (const token of ['"milestone","current"', '"--status","running","--force"']) {
      expect(commands, `commands.md missing ${token}`).toContain(token);
    }
    expect(conditions).toContain('--force');
    expect(conditions).toContain('`-f`');
  });
});
