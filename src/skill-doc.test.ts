import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { MINT_TOOL_GUIDANCE } from './context.js';
import { MINT_TOOL_DESCRIPTION } from './mint-tool.js';

/**
 * The skill body is the largest thing the plugin installs, and it is loaded
 * whenever the skill triggers (#62). Two contracts are worth pinning:
 *
 * 1. It stays small — the always-loaded SKILL.md is cut to about half of what it
 *    was, with detail pushed into `references/` (read on demand).
 * 2. The mandatory workflow rules survive every slimming pass, and the
 *    tool-first policy is not restated here (it lives in the always-on guidance).
 */
const SKILL_DIR = fileURLToPath(new URL('../skill', import.meta.url));
const skill = readFileSync(`${SKILL_DIR}/SKILL.md`, 'utf8');
const bytes = (text: string): number => Buffer.byteLength(text, 'utf8');

/** Rules that must never be trimmed away — one per hard workflow gate. */
const RULE_MARKERS: readonly string[] = [
  'plan 双向绑定',
  'exit_plan_mode',
  '"issue","state","start"',
  '"issue","state","commit"',
  'plan close',
  'dev-clean',
  '- [ ]',
  'label',
  'running milestone',
  '不得自行置 running',
  'state drop',
  '接管模式',
  'references/labels.md',
  '须走 bash',
];

describe('skill body (#62)', () => {
  it('stays under half of its pre-slim size', () => {
    // 13883 B before #62; the ceiling is the acceptance criterion, not a guess.
    expect(bytes(skill)).toBeLessThanOrEqual(7000);
  });

  it.each(RULE_MARKERS)('keeps the rule marker %s', (marker) => {
    expect(skill).toContain(marker);
  });

  it('leaves the tool-first policy to the always-on guidance', () => {
    expect(skill).not.toContain('不要用 bash');
    expect(skill).not.toContain('不经 bash');
    expect(MINT_TOOL_DESCRIPTION).not.toContain('不要用 bash');
    expect(MINT_TOOL_DESCRIPTION).not.toContain('不经 bash');
    expect(MINT_TOOL_GUIDANCE).toContain('不经 bash');
  });

  it('points at reference files that all exist', () => {
    const referenced = new Set(
      [
        ...skill.matchAll(
          /`(?:references\/)?((?:flow-[a-z-]+|commands|state-machine|labels)\.md)`/g
        ),
      ].map((match) => match[1])
    );
    expect(referenced.size).toBeGreaterThanOrEqual(8);
    for (const file of referenced) {
      expect(existsSync(`${SKILL_DIR}/references/${file}`), `${file} missing`).toBe(true);
    }
  });

  it('keeps the label conventions in their own reference', () => {
    const labels = readFileSync(`${SKILL_DIR}/references/labels.md`, 'utf8');
    expect(labels).toContain('上限 5 个');
    expect(labels).toContain('英文');
    expect(labels).toContain('不主动清理');
  });
});
