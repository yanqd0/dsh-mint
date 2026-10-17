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
  // 「谁执行」是独立于「怎么分批」的一条口径：只有一条链的会话也必须派子代理，
  // main 不亲自实现。钉住它，防止再次退化成「串行就由 main 依次执行」。
  '串行也要派子代理',
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
    [
      '总—分—总',
      'ask_user_question',
      '派子代理',
      '注入前置纪律',
      '委派允许两级',
      // research intake is a reading problem: materials that can be delegated
      // (whole references/notes, repo-wide sweeps) and the reply shape that
      // keeps the middle product in the child session live here, so the
      // research phase stops eating the main window.
      '读材料',
      '回执形状',
    ],
  ],
  // `dag-exec` owns the graph's *shape*: an edge is a semantic dependency only.
  // Execution order (same-file serialisation, one node at a time, batch order)
  // belongs to the batch table — encoded as edges it degenerates the graph into
  // a line that later readers misread as "everything blocks everything".
  // Rework is a reopen, not a new node: a failed test re-runs its own test node.
  [
    'references/dag-exec.md',
    [
      '给子代理',
      '留 main',
      '五轴',
      '无环',
      '执行序不进边',
      'reopen 同一个 test 节点重跑',
      // an oversized node is a split signal, not a tool error: the split is by
      // file ownership, and it happens before any debate about parallelism.
      '超预算先按文件归属拆节点',
    ],
  ],
  // the container derivation table now mirrors mint's `derive.rs` — `open`
  // children derive an `open` plan (not `running`), which is the fact the plan
  // gate and the deadlock analysis in the same reference both rest on.
  ['references/state-machine.md', ['全 `open` 的 plan 派生 `open`', 'partial', 'derive.rs']],
  // the parallel-execution contract (batch table, subagent dispatch, no
  // sleeps, state commit) lives in its own reference. It also owns the dev/test
  // node pair — one edge only, `test 依赖 dev`; and the one channel a subagent
  // may use for a user decision (write it into the final reply —
  // `ask_user_question` is refused for a delegated caller). The four-line reply
  // is the only hand-back shape: pinning its labels keeps a refactor from
  // silently inventing a new contract for the dispatch prompt. The deviation
  // route (redo-the-split, the isolation-mechanism exception) moved to
  // `exec-fallback.md`, so parallel-exec keeps only the default shape.
  [
    'references/parallel-exec.md',
    [
      '并行批次',
      'subagent',
      '不 sleep',
      'state commit',
      'dev/test 节点对',
      'test 依赖 dev',
      '遇用户决策写进最终回复',
      '不要调用 `ask_user_question`',
      '节点: ',
      '变更: ',
      '验收: ',
      '未决: ',
      // brief 的字节序契约与读取分工：逐字固定头 + 变体槽是前缀缓存的唯一
      // 抓手；AGENTS.md 由 harness 注入、范围读（offset/limit）与「谁读什么」
      // 是同一块钱的另外三面；节点体量预算给「多少步算过大」一个判据。
      '逐字固定头',
      '变体槽',
      'AGENTS.md 已注入',
      '读取粒度',
      '谁读什么',
      '预期步数上限',
      // 硬上限与「口径清单」是同一轮实测补上的：白名单文件数是最好的先验信号，
      // 固定头必须自带本仓口径（注释语言等）才不用收口返工；bash 输出要收窄。
      '本项目口径清单',
      'bash 只回吐事实行',
      // 工作目录纪律的唯一落点：子代理默认 cwd 是主工作树，固定头必须要求所有
      // 命令显式带 `workdir`（worktree 批次 = 树路径），否则树建好也照样改错地方。
      '显式带 `workdir`',
    ],
  ],
  // The fallback is deliberately **not** on the default path: it holds what to
  // do once worktree parallelism is blocked. `相交文件`/`合成哪个节点`/
  // `为什么合并不了` are the three columns a deviation must add to the batch
  // table — the only mechanically checkable part of the "parallel by default"
  // change; without them a "files intersect → serial" one-liner would pass as
  // if the re-split had been attempted. The named exception must stay spelled
  // out, since it is the one sanctioned way to switch worktree off.
  [
    'references/exec-fallback.md',
    [
      '相交文件',
      '合成哪个节点',
      '为什么合并不了',
      '共享工作区',
      '被改特性本身就是隔离机制',
      'maxDepth',
    ],
  ],
  // A dev/test pair shares **one** tree: `create`/`merge`/`remove` all name the
  // dev node, and both nodes may be `running` at once (the dev subagent
  // dispatches its own test child). A second tree would break the pairing.
  // Tree-side operations are the other half: dependencies are really installed
  // in the tree (never symlinked from the main repo — the package manager then
  // rewrites the *main* repo's top-level links by the tree's depth), the
  // project's own commit hook implicitly installs via `verifyDepsBeforeRun`,
  // and a path containing `.git/` trips `server.fs.deny`. Pinning them keeps
  // the silent-corruption route from coming back.
  [
    'references/worktree-exec.md',
    [
      'dev/test 节点对只建一棵树',
      '两节点可同时 `running`',
      '树内真装',
      'verifyDepsBeforeRun',
      'server.fs.deny',
    ],
  ],
  // cross-project registration carries its source, and the tool gate is
  // one confirmation per session and target project — not per call. A subagent
  // has no approval channel at all, so a decision it hits travels back in its
  // final reply and the root agent merges the round's decisions into one
  // question before writing anything (the marker below pins that wording here,
  // next to the gate it belongs to; the dispatch discipline lives in
  // `parallel-exec.md`). The target project is confirmed first, kind is
  // problem/requirement, the title may stay free of the source, and the report
  // avoids prescribing a fix.
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
      '根 agent 合并成一次提问',
    ],
  ],
];

describe('skill layout', () => {
  // 常驻预算门禁：SKILL.md 只买「机制 + 路由」，超出 3200 B 就说明分支内容没拆到 references。
  // 直接按 UTF-8 字节量 SKILL.md，断言不超过标注的上限（历史值见下方注释）。
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

  // 拆分不许丢规则：搬出 SKILL.md 的门禁必须在各自的新家文件里仍然存在。
  // 遍历 `HOME_MARKERS` 的「文件 → 标记」表，先确认文件在盘上，再逐个断言文本命中。
  it('keeps the markers that moved out of SKILL.md in their home file', () => {
    for (const [file, markers] of HOME_MARKERS) {
      expect(existsSync(`${SKILL_DIR}/${file}`), `${file} missing`).toBe(true);
      const text = read(file);
      for (const marker of markers) {
        expect(text, `${file} missing ${marker}`).toContain(marker);
      }
    }
  });

  // 回归钉：工具优先的口径只许留在常驻 guidance 里，不许回到 skill 或工具描述（旧写法已删）。
  // 对 SKILL.md 与工具描述断言不含旧文案，对 `MINT_TOOL_GUIDANCE` 断言必须含。
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

  // 回归钉：`blocked-by` 的 kebab 拼写是 CLI 唯一认的形状，下划线写法必须不再出现。
  // 读 `references/commands.md`，正向断言 kebab 串、反向断接下划线串。
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
