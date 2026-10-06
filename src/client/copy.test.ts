import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { EN, KEPT_IN_ENGLISH, NS, ZH, createTranslator } from './copy.js';
import type { CopyKey } from './copy.js';

/**
 * `src/client` — the directory whose every visible string must come out of
 * `copy.ts`. The guards below read it as text, the same way
 * `src/client-bundle.test.ts` inspects its built artifact.
 */
const CLIENT_DIR = fileURLToPath(new URL('.', import.meta.url));

/** The dictionary itself and the tests carry non-copy text by design. */
const NOT_CALL_SITES = new Set(['copy.ts']);

/** Keys whose English text may exceed the layout budget, with a stated reason. */
const WIDTH_EXEMPT: readonly CopyKey[] = [];

const KEYS = Object.keys(ZH) as CopyKey[];

/** Every client source that calls the copy seat, as text. */
function callSites(): Array<{ file: string; text: string }> {
  return readdirSync(CLIENT_DIR)
    .filter(
      (name) =>
        (name.endsWith('.ts') || name.endsWith('.tsx')) &&
        !NOT_CALL_SITES.has(name) &&
        !name.includes('.test.')
    )
    .map((name) => ({ file: name, text: readFileSync(join(CLIENT_DIR, name), 'utf8') }));
}

/** Named placeholders in a template, sorted: `{a} {b}` → `['a', 'b']`. */
function placeholders(text: string): string[] {
  return [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1] ?? '').sort();
}

/** Display columns: a CJK/fullwidth character is twice a Latin one. */
function width(text: string): number {
  return [...text].reduce(
    (total, char) => total + ((char.codePointAt(0) ?? 0) >= 0x2e80 ? 2 : 1),
    0
  );
}

/** True when the text carries a CJK/fullwidth character. */
function hasWide(text: string): boolean {
  return [...text].some((char) => (char.codePointAt(0) ?? 0) >= 0x2e80);
}

describe('panel copy', () => {
  it('namespaces the dictionary under `mint`', () => {
    expect(NS).toBe('mint');
  });

  it('carries the same non-empty key set in both locales', () => {
    expect(Object.keys(EN).sort()).toEqual(Object.keys(ZH).sort());
    for (const key of KEYS) {
      expect(key.length, 'a key cannot be empty').toBeGreaterThan(0);
      expect(ZH[key].length, `zh copy for ${key} cannot be empty`).toBeGreaterThan(0);
      expect(EN[key].length, `en copy for ${key} cannot be empty`).toBeGreaterThan(0);
    }
  });

  // A key that names a placeholder in one locale and another in the other would
  // interpolate nothing and print the placeholder itself.
  it('uses the same named placeholders in both locales', () => {
    for (const key of KEYS) {
      expect(placeholders(EN[key]), key).toEqual(placeholders(ZH[key]));
    }
  });

  // The one place the "Issue / Plan / Milestone stay English" decision is
  // enforced: every other key must actually be translated.
  it('keeps exactly the registered keys identical, and translates the rest', () => {
    for (const key of KEYS) {
      if (KEPT_IN_ENGLISH.includes(key)) {
        expect(EN[key], `${key} is kept in English`).toBe(ZH[key]);
      } else {
        expect(EN[key], `${key} must differ between locales`).not.toBe(ZH[key]);
      }
    }
  });

  // English runs longer than Chinese at the same meaning; the panel's capsules
  // and toolbar rows are narrow, so a translation may not run away from its
  // Chinese source (twice the columns, or one short label plus twelve).
  it('keeps every English string inside the layout budget', () => {
    for (const key of KEYS) {
      if (WIDTH_EXEMPT.includes(key)) continue;
      const zh = width(ZH[key]);
      const en = width(EN[key]);
      expect(en, `${key}: EN ${String(en)} cols, ZH ${String(zh)}`).toBeLessThanOrEqual(
        Math.max(zh * 2, zh + 12)
      );
    }
  });

  it('is the only file the panel text lives in', () => {
    for (const { file, text } of callSites()) {
      expect(hasWide(text), `${file} must not carry hard-coded Chinese copy`).toBe(false);
    }
  });

  it('has no key the panel never asks for', () => {
    const sources = callSites()
      .map(({ text }) => text)
      .join('\n');
    for (const key of KEYS) {
      expect(sources.includes(`'${key}'`), `${key} is never used`).toBe(true);
    }
  });

  // Both lists hide their end states by default, so the switch names the state
  // class, not one status: `dropped` and `partial` count as ended too.
  it('names the end-state switch for both lists', () => {
    expect(ZH['panel.allStates']).toBe('含已结束');
    expect(EN['panel.allStates']).toBe('Include ended');
  });

  // Chinese has no plural form, English does; the pair is what the count path
  // picks from, so neither locale may collapse the other's contract.
  it('carries a singular and a plural form for a count', () => {
    expect(EN['count.issue.one']).not.toBe(EN['count.issue.other']);
    expect(ZH['count.issue.one']).toBe(ZH['count.issue.other']);
  });

  // The seat is a plain narrowing: whatever the bound translator answers is what
  // the panel shows, so a locale without this namespace shows the key rather
  // than silently falling back to Chinese.
  it('passes the bound translation through and forwards params', () => {
    const seen: Array<Record<string, string | number> | undefined> = [];
    const t = createTranslator((key, params) => {
      seen.push(params);
      return key === 'view.issues' ? 'Issues' : key;
    });
    expect(t('view.issues')).toBe('Issues');
    expect(t('state.empty')).toBe('state.empty');
    expect(t('pager.summary', { page: 2 })).toBe('pager.summary');
    expect(seen).toEqual([undefined, undefined, { page: 2 }]);
  });
});
