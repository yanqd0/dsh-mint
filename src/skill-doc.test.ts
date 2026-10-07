import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { MINT_TOOL_GUIDANCE } from './context.js';
import { MINT_TOOL_DESCRIPTION } from './mint-tool.js';

/**
 * Skill layout contracts (#71).
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
const SKILL_DIR = fileURLToPath(new URL('../skill', import.meta.url));
const REF_DIR = `${SKILL_DIR}/references`;
const read = (name: string): string => readFileSync(`${SKILL_DIR}/${name}`, 'utf8');
const bytes = (text: string): number => Buffer.byteLength(text, 'utf8');

const skill = read('SKILL.md');

/**
 * Reference files SKILL.md names (#138).
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
  // #138: reference paths are written relative to `references/` (the router
  // states that base), so the marker pins the pointer, not the prefix.
  '`labels.md`',
  '跨项目登记',
  // #114: the default project is the session cwd, so own-project calls take no
  // `-p`. Pinned as a marker because trimming it re-opens the exact behaviour
  // this plan fixed.
  '本项目操作不带 `-p`',
  // #122: parallel batches are the plan-level constraint that keeps
  // concurrently delegated work off the same files.
  '并行批次',
  // #128: registration never pre-schedules; `plan plan` belongs to the start of
  // work, not to filing the issue.
  '提 issue 一律 open',
  // #140: one milestone carries at most one running plan — the second is refused
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
  // #128: a filed requirement stays open; a plan is created only when work
  // actually starts. #141: a freshly created plan (plan mode or not) also stays
  // `open` until the start-of-work point locks it.
  ['references/flow-requirement.md', ['登记一律', '不预建 mint plan', '保持 `open`']],
  // #112: both legal orders (build-then-run / run-then-backfill) live in
  // flow-impl, and the issue ordering rule left SKILL.md's body for the place
  // that already carried it (flow-session's step 4).
  // #128: the batch lock is a start-of-work action, not an attach-time one.
  // #119: the host todo panel is the human's progress view, so the derive/sync
  // discipline has to survive in flow-impl.
  // #136: the binding is one-way and the start-of-work point has two shapes
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
      // #140: the three-condition gate sheet lives in flow-impl (the criterion,
      // the milestone bucket, and the convergence paths for a refusal).
      '至多一个 running plan',
      // #141: locking `planned` at the exit point needs this session to actually
      // start the work; registration-only sessions leave everything `open`.
      '确实要开工',
    ],
  ],
  ['references/flow-session.md', ['priority 升序', '按 id 升序', '单个 issue']],
  // plan #30: the DAG discipline split into its two halves. `plan-dag` owns the
  // pre-approval research loop (total-split-total, user decisions only at the
  // "totals", injection discipline); `dag-exec` owns the post-approval panorama
  // (layering by the five axes, who runs what, append-no-cycle rework).
  ['references/plan-dag.md', ['总—分—总', 'ask_user_question', '派子代理', '注入前置纪律']],
  ['references/dag-exec.md', ['给子代理', '留 main', '五轴', '无环']],
  // #137: the container derivation table now mirrors mint's `derive.rs` — `open`
  // children derive an `open` plan (not `running`), which is the fact the plan
  // gate and #135's deadlock analysis both rest on.
  ['references/state-machine.md', ['全 `open` 的 plan 派生 `open`', 'partial', 'derive.rs']],
  // #122: the parallel-execution contract (batch table, subagent dispatch, no
  // sleeps, state commit) lives in its own reference.
  ['references/parallel-exec.md', ['并行批次', 'subagent', '不 sleep', 'state commit']],
  // #81: cross-project registration carries its source, and the tool gate is
  // one confirmation per session and target project — not per call.
  // #91: the target project is confirmed first, kind is problem/requirement, the
  // title may stay free of the source, and the report avoids prescribing a fix.
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

describe('skill layout (#71)', () => {
  it('keeps the always-loaded body inside the router budget', () => {
    // 6965 B before the split; 3987 B before the #138 refactor. The ceiling was
    // re-pinned to 3200 B with that refactor (non-mainline sections moved into
    // references), so the always-loaded body pays for gates + routing only.
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

  it('documents the kebab link value the CLI accepts (#73)', () => {
    const commands = read('references/commands.md');
    expect(commands).toContain('"blocked-by"');
    expect(commands).not.toContain('"blocked_by"');
  });

  it('documents the mint 0.8 surface the workflows rely on (#74)', () => {
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

  // #104/#117: the CLI refuses any write that would add a running milestone, and
  // `milestone set --status running --force` is its only escape hatch. The skill
  // has to carry both the read (`current`) and the escape hatch, or a session
  // reasons its way into a rejected command.
  it('documents the single-running guard the workflows rely on (#104/#117)', () => {
    const commands = read('references/commands.md');
    const conditions = read('references/flow-conditions.md');
    for (const token of ['"milestone","current"', '"--status","running","--force"']) {
      expect(commands, `commands.md missing ${token}`).toContain(token);
    }
    expect(conditions).toContain('--force');
    expect(conditions).toContain('`-f`');
  });
});
