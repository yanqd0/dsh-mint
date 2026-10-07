import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { REPO_ROOT } from '../helpers/repo.js';

/**
 * Bilingual README contract (#152).
 *
 * `README.md` and `README.zh.md` are a mandatory pair (see AGENTS.md): same
 * structure, same section order, each linking to the other. The README is the
 * **user-facing** page — install / use / configure / uninstall plus a capability
 * overview — so it also has a size ceiling that keeps developer material in
 * `CONTRIBUTING.md` instead of growing back.
 */
const EN = readFileSync(`${REPO_ROOT}/README.md`, 'utf8');
const ZH = readFileSync(`${REPO_ROOT}/README.zh.md`, 'utf8');

/** Bytes, the unit the size ceiling is stated in. */
function bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/** Lines of `markdown` outside fenced code blocks. */
function proseLines(markdown: string): string[] {
  const lines: string[] = [];
  let inFence = false;
  for (const line of markdown.split('\n')) {
    if (/^\s*```/u.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) lines.push(line);
  }
  return lines;
}

/** Heading levels, in document order: `## Install` → 2. */
function headingLevels(markdown: string): number[] {
  const levels: number[] = [];
  for (const line of proseLines(markdown)) {
    const match = /^(#{1,6})\s/u.exec(line);
    if (match?.[1] !== undefined) levels.push(match[1].length);
  }
  return levels;
}

/**
 * GitHub-style anchor of a heading.
 *
 * Headings are plain text here (the pair is bilingual, so only the *shape* is
 * compared), and CJK survives the punctuation strip, matching what GitHub keeps
 * for `## 环境要求` → `#环境要求`.
 */
function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .trim()
    .replace(/\s+/gu, '-');
}

/** Every heading anchor the document offers. */
function anchors(markdown: string): Set<string> {
  const found = new Set<string>();
  for (const line of proseLines(markdown)) {
    const match = /^#{1,6}\s+(.*\S)\s*$/u.exec(line);
    if (match?.[1] !== undefined) found.add(slug(match[1]));
  }
  return found;
}

/** In-document link targets: `](#anchor)` → `anchor`. */
function linkTargets(markdown: string): string[] {
  const found: string[] = [];
  for (const match of markdown.matchAll(/\]\(#([^)\s]+)\)/gu)) {
    const target = match[1];
    if (target === undefined) continue;
    try {
      found.push(decodeURIComponent(target));
    } catch {
      found.push(target);
    }
  }
  return found;
}

describe('README bilingual pair (#152)', () => {
  it('links the two languages to each other', () => {
    expect(EN).toContain('(README.zh.md)');
    expect(ZH).toContain('(README.md)');
  });

  it('keeps the same section structure', () => {
    const english = headingLevels(EN);
    expect(english.length).toBeGreaterThan(5);
    expect(headingLevels(ZH)).toEqual(english);
  });

  it('resolves every in-document link to a heading', () => {
    for (const [language, markdown] of [
      ['README.md', EN],
      ['README.zh.md', ZH],
    ] as const) {
      const offered = anchors(markdown);
      const missing = linkTargets(markdown).filter((target) => !offered.has(target));
      expect(missing, `${language} has dangling anchors`).toEqual([]);
    }
  });

  // The ceiling is the point of the split: developer material belongs in
  // CONTRIBUTING.md, and a README that grows past this has drifted back.
  it('stays a user-facing short read', () => {
    expect(bytes(EN)).toBeLessThanOrEqual(8192);
    expect(bytes(ZH)).toBeLessThanOrEqual(8192);
  });
});
