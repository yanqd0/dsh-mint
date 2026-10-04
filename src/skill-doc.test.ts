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

/** Gates that must never be trimmed out of the always-loaded SKILL.md. */
const SKILL_MARKERS: readonly string[] = [
  'plan 双向绑定',
  'exit_plan_mode',
  '记录必须有，顺序可换',
  '"issue","state","start"',
  '"issue","state","commit"',
  'plan close',
  'running milestone',
  '不得自行置 running',
  '须走 bash',
  'references/labels.md',
  '跨项目登记',
  // #114: the default project is the session cwd, so own-project calls take no
  // `-p`. Pinned as a marker because trimming it re-opens the exact behaviour
  // this plan fixed.
  '本项目操作不带 `-p`',
  // #122: parallel batches are the plan-level constraint that keeps
  // concurrently delegated work off the same files.
  '并行批次',
];

/** Rules that moved out of SKILL.md must still exist in their home file. */
const HOME_MARKERS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['references/template-guide.md', ['- [ ]', 'title-templates/', 'body-templates/']],
  ['references/body-editing.md', ['--body-section', '- [ ]', 'section not found']],
  ['references/constraints.md', ['state drop', 'plan drop', '--force-new']],
  ['references/flow-planning.md', ['dev-clean', 'task']],
  ['references/labels.md', ['上限 5 个', '英文', '不主动清理']],
  // #112: both legal orders (build-then-run / run-then-backfill) live in
  // flow-impl, and the issue ordering rule left SKILL.md's body for the place
  // that already carried it (flow-session's step 4).
  ['references/flow-impl.md', ['先跑后建', '记录必须有', '顺序可换']],
  ['references/flow-session.md', ['priority 升序', '按 id 升序']],
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
    // 6965 B before the split; the ceiling is the AGENTS.md budget, not a guess.
    expect(bytes(skill)).toBeLessThanOrEqual(4000);
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
    const named = new Set([...skill.matchAll(/`references\/([a-z0-9-]+\.md)`/g)].map((m) => m[1]));
    expect(named.size).toBeGreaterThanOrEqual(14);
    for (const file of named) {
      expect(existsSync(`${REF_DIR}/${file}`), `${file} missing`).toBe(true);
    }
  });

  it('leaves no orphan reference', () => {
    const named = new Set([...skill.matchAll(/`references\/([a-z0-9-]+\.md)`/g)].map((m) => m[1]));
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
});
