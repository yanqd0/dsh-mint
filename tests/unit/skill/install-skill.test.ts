import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import { srcPath } from '../../helpers/repo.js';
import {
  OWNER_MARKER,
  frontmatterName,
  installSkill,
  looksLikeOurSkill,
  resolveDshHome,
  skillSource,
  skillTarget,
} from '../../../src/skill/install-skill.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-mint-skill-'));
}

/** A skill file with the shipped frontmatter, so a copy is identifiable (#153). */
function skillFile(body: string): string {
  return `---\nname: mint\ndescription: test\n---\n\n${body}\n`;
}

/**
 * Write a skill tree by hand: `files` are relative to `target`, and the
 * ownership marker is included unless `marker: false` asks for a pre-marker or
 * foreign copy.
 */
function seed(target: string, files: Record<string, string>, marker = true): void {
  for (const [relative, body] of Object.entries(files)) {
    const full = join(target, relative);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
  if (marker) writeFileSync(join(target, OWNER_MARKER), '@yanqd0/dsh-mint\n');
}

describe('resolveDshHome', () => {
  it('honours DSH_HOME', () => {
    expect(resolveDshHome({ DSH_HOME: '/custom/dsh' })).toBe('/custom/dsh');
  });

  it('falls back to ~/.dsh', () => {
    expect(resolveDshHome({})).toBe(join(homedir(), '.dsh'));
  });
});

describe('skillTarget', () => {
  it('joins the discovery path', () => {
    expect(skillTarget('/home/x/.dsh')).toBe(join('/home/x/.dsh', 'skills', 'mint'));
  });
});

describe('skillSource', () => {
  it('points beside the module (dist/skill after build)', () => {
    // 只钉「skill 就在模块同目录」这一契约：开发态是 src/skill/skill，
    // 构建后是 dist/skill（tsup entry key `install-skill` 保证邻近关系）。
    expect(skillSource()).toBe(srcPath('skill', 'skill'));
  });
});

describe('frontmatterName', () => {
  it('reads the name of the leading block', () => {
    expect(frontmatterName('---\nname: mint\ndescription: x\n---\n\nbody\n')).toBe('mint');
  });

  it('accepts quoted names and ignores other fields', () => {
    expect(frontmatterName('---\nname: "mint"\n---\nbody')).toBe('mint');
  });

  it('is undefined without a parseable block', () => {
    expect(frontmatterName('body only')).toBeUndefined();
    expect(frontmatterName('---\ndescription: x\n---\nbody')).toBeUndefined();
  });
});

describe('looksLikeOurSkill (#153)', () => {
  it('recognises a marked copy', () => {
    const target = join(tempDir(), 'mint');
    seed(target, { 'SKILL.md': 'anything' });
    expect(looksLikeOurSkill(target)).toBe(true);
  });

  it('recognises a pre-marker copy by its frontmatter', () => {
    const target = join(tempDir(), 'mint');
    seed(target, { 'SKILL.md': skillFile('body') }, false);
    expect(looksLikeOurSkill(target)).toBe(true);
  });

  it('rejects a foreign directory or a missing one', () => {
    const root = tempDir();
    const foreign = join(root, 'other');
    seed(foreign, { 'SKILL.md': '---\nname: something-else\n---\nbody' }, false);
    expect(looksLikeOurSkill(foreign)).toBe(false);
    expect(looksLikeOurSkill(join(root, 'nope'))).toBe(false);
  });
});

describe('installSkill', () => {
  it('copies the source into the DSH skill directory', () => {
    const root = tempDir();
    const source = join(root, 'src');
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, 'SKILL.md'), 'skill');
    const dshHome = join(root, 'dsh');
    const logs: string[] = [];

    const result = installSkill({ dshHome, source, log: (m) => logs.push(m) });

    expect(result.ok).toBe(true);
    const target = join(dshHome, 'skills', 'mint');
    expect(readFileSync(join(target, 'SKILL.md'), 'utf8')).toBe('skill');
    // the ownership marker rides along, so a later load can identify the copy
    expect(existsSync(join(target, OWNER_MARKER))).toBe(true);
    expect(looksLikeOurSkill(target)).toBe(true);
    expect(logs).toEqual([]);
  });

  it('replaces a stale copy on reinstall', () => {
    const root = tempDir();
    const source = join(root, 'src');
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, 'SKILL.md'), 'new');
    const dshHome = join(root, 'dsh');
    const target = join(dshHome, 'skills', 'mint');
    seed(target, { 'SKILL.md': 'old', 'stale.md': 'stale' });

    const result = installSkill({ dshHome, source });

    expect(result.ok).toBe(true);
    expect(readFileSync(join(target, 'SKILL.md'), 'utf8')).toBe('new');
    expect(existsSync(join(target, 'stale.md'))).toBe(false);
  });

  it('repairs a copy interrupted before its SKILL.md landed (#153)', () => {
    const root = tempDir();
    const source = join(root, 'src');
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, 'SKILL.md'), 'full');
    const dshHome = join(root, 'dsh');
    const target = join(dshHome, 'skills', 'mint');
    // marker only: a sync that died before copying anything
    seed(target, { 'references/leftover.md': 'partial' });

    const result = installSkill({ dshHome, source });

    expect(result.ok).toBe(true);
    expect(readFileSync(join(target, 'SKILL.md'), 'utf8')).toBe('full');
    expect(existsSync(join(target, 'references', 'leftover.md'))).toBe(false);
  });

  it('leaves an up-to-date copy untouched (sync skip)', () => {
    const root = tempDir();
    const source = join(root, 'src');
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, 'SKILL.md'), 'same');
    const dshHome = join(root, 'dsh');
    const target = join(dshHome, 'skills', 'mint');
    seed(target, { 'SKILL.md': 'same', 'sentinel.txt': 'keep' });

    const result = installSkill({ dshHome, source });

    expect(result.ok).toBe(true);
    expect(existsSync(join(target, 'sentinel.txt'))).toBe(true);
  });

  it('re-syncs when a reference changed but SKILL.md is identical (#72)', () => {
    const root = tempDir();
    const source = join(root, 'src');
    mkdirSync(join(source, 'references'), { recursive: true });
    writeFileSync(join(source, 'SKILL.md'), 'same');
    writeFileSync(join(source, 'references', 'a.md'), 'new');
    const dshHome = join(root, 'dsh');
    const target = join(dshHome, 'skills', 'mint');
    seed(target, { 'SKILL.md': 'same', 'references/a.md': 'old' });

    const result = installSkill({ dshHome, source });

    expect(result.ok).toBe(true);
    expect(readFileSync(join(target, 'references', 'a.md'), 'utf8')).toBe('new');
  });

  it('re-syncs when the copy is missing a reference (#72)', () => {
    const root = tempDir();
    const source = join(root, 'src');
    mkdirSync(join(source, 'references'), { recursive: true });
    writeFileSync(join(source, 'SKILL.md'), 'same');
    writeFileSync(join(source, 'references', 'b.md'), 'body');
    const dshHome = join(root, 'dsh');
    const target = join(dshHome, 'skills', 'mint');
    seed(target, { 'SKILL.md': 'same' });

    const result = installSkill({ dshHome, source });

    expect(result.ok).toBe(true);
    expect(readFileSync(join(target, 'references', 'b.md'), 'utf8')).toBe('body');
  });

  it('replaces a pre-marker copy of this skill (#153)', () => {
    const root = tempDir();
    const source = join(root, 'src');
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, 'SKILL.md'), 'new');
    const dshHome = join(root, 'dsh');
    const target = join(dshHome, 'skills', 'mint');
    seed(target, { 'SKILL.md': skillFile('old') }, false);

    const result = installSkill({ dshHome, source });

    expect(result.ok).toBe(true);
    expect(readFileSync(join(target, 'SKILL.md'), 'utf8')).toBe('new');
    expect(looksLikeOurSkill(target)).toBe(true);
  });

  it('leaves a foreign directory alone (#153)', () => {
    const root = tempDir();
    const source = join(root, 'src');
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, 'SKILL.md'), 'ours');
    const dshHome = join(root, 'dsh');
    const target = join(dshHome, 'skills', 'mint');
    const foreign = '---\nname: someone-elses\n---\n\nbody\n';
    seed(target, { 'SKILL.md': foreign, 'notes.md': 'mine' }, false);
    const logs: string[] = [];

    const result = installSkill({ dshHome, source, log: (m) => logs.push(m) });

    expect(result).toEqual({ ok: false, reason: 'foreign skill' });
    expect(readFileSync(join(target, 'SKILL.md'), 'utf8')).toBe(foreign);
    expect(readFileSync(join(target, 'notes.md'), 'utf8')).toBe('mine');
    expect(logs.some((m) => m.includes('not this plugin'))).toBe(true);
  });

  it('takes a foreign directory over only with force (#153)', () => {
    const root = tempDir();
    const source = join(root, 'src');
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, 'SKILL.md'), 'ours');
    const dshHome = join(root, 'dsh');
    const target = join(dshHome, 'skills', 'mint');
    seed(target, { 'SKILL.md': '---\nname: someone-elses\n---\nbody' }, false);

    const result = installSkill({ dshHome, source, force: true });

    expect(result.ok).toBe(true);
    expect(readFileSync(join(target, 'SKILL.md'), 'utf8')).toBe('ours');
  });

  it('leaves a dev symlink untouched', () => {
    const root = tempDir();
    const source = join(root, 'src');
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, 'SKILL.md'), 'new');
    const real = join(root, 'real');
    mkdirSync(real, { recursive: true });
    writeFileSync(join(real, 'SKILL.md'), 'dev');
    const target = join(root, 'dsh', 'skills', 'mint');
    mkdirSync(join(root, 'dsh', 'skills'), { recursive: true });
    symlinkSync(real, target);

    const result = installSkill({ dshHome: join(root, 'dsh'), source });

    expect(result).toEqual({ ok: true, reason: 'symlink' });
    expect(lstatSync(target).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(target, 'SKILL.md'), 'utf8')).toBe('dev');
  });

  it('reports a dangling symlink instead of clobbering it (#153)', () => {
    const root = tempDir();
    const source = join(root, 'src');
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, 'SKILL.md'), 'new');
    const target = join(root, 'dsh', 'skills', 'mint');
    mkdirSync(join(root, 'dsh', 'skills'), { recursive: true });
    symlinkSync(join(root, 'gone'), target);
    const logs: string[] = [];

    const result = installSkill({ dshHome: join(root, 'dsh'), source, log: (m) => logs.push(m) });

    expect(result).toEqual({ ok: false, reason: 'dangling symlink' });
    expect(lstatSync(target).isSymbolicLink()).toBe(true);
    expect(logs.some((m) => m.includes('dangling symlink'))).toBe(true);
  });

  it('force replaces a symlink with a fresh copy (#153)', () => {
    const root = tempDir();
    const source = join(root, 'src');
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, 'SKILL.md'), 'new');
    const real = join(root, 'real');
    mkdirSync(real, { recursive: true });
    writeFileSync(join(real, 'SKILL.md'), 'dev');
    const target = join(root, 'dsh', 'skills', 'mint');
    mkdirSync(join(root, 'dsh', 'skills'), { recursive: true });
    symlinkSync(real, target);

    const result = installSkill({ dshHome: join(root, 'dsh'), source, force: true });

    expect(result.ok).toBe(true);
    expect(lstatSync(target).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(target, 'SKILL.md'), 'utf8')).toBe('new');
    // the link was removed, never the directory it pointed at
    expect(readFileSync(join(real, 'SKILL.md'), 'utf8')).toBe('dev');
  });

  it('reports a missing source without throwing', () => {
    const root = tempDir();
    const logs: string[] = [];
    const result = installSkill({
      dshHome: join(root, 'dsh'),
      source: join(root, 'nope'),
      log: (m) => logs.push(m),
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('source missing');
    expect(logs.some((m) => m.includes('source missing'))).toBe(true);
  });

  it('reports copy failures without throwing', () => {
    const root = tempDir();
    const source = join(root, 'src');
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, 'SKILL.md'), 'skill');
    // dshHome is a FILE, so creating the skills/mint tree under it fails
    writeFileSync(join(root, 'dsh'), 'not a dir');
    const logs: string[] = [];
    const result = installSkill({
      dshHome: join(root, 'dsh'),
      source,
      log: (m) => logs.push(m),
    });

    expect(result.ok).toBe(false);
    expect(logs.some((m) => m.includes('skill install failed'))).toBe(true);
  });
});
