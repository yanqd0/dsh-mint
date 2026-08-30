import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import { installSkill, resolveDshHome, skillSource, skillTarget } from './install-skill.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-mint-skill-'));
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
    expect(skillSource().endsWith(join('src', 'skill'))).toBe(true);
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
    expect(readFileSync(join(dshHome, 'skills', 'mint', 'SKILL.md'), 'utf8')).toBe('skill');
    expect(logs).toEqual([]);
  });

  it('replaces a stale copy on reinstall', () => {
    const root = tempDir();
    const source = join(root, 'src');
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, 'SKILL.md'), 'new');
    const dshHome = join(root, 'dsh');
    const target = join(dshHome, 'skills', 'mint');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'SKILL.md'), 'old');
    writeFileSync(join(target, 'stale.md'), 'stale');

    const result = installSkill({ dshHome, source });

    expect(result.ok).toBe(true);
    expect(readFileSync(join(target, 'SKILL.md'), 'utf8')).toBe('new');
    expect(existsSync(join(target, 'stale.md'))).toBe(false);
  });

  it('leaves an up-to-date copy untouched (sync skip)', () => {
    const root = tempDir();
    const source = join(root, 'src');
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, 'SKILL.md'), 'same');
    const dshHome = join(root, 'dsh');
    const target = join(dshHome, 'skills', 'mint');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'SKILL.md'), 'same');
    // a user-side sentinel that a fresh copy would not carry
    writeFileSync(join(target, 'sentinel.txt'), 'keep');

    const result = installSkill({ dshHome, source });

    expect(result.ok).toBe(true);
    expect(existsSync(join(target, 'sentinel.txt'))).toBe(true);
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

    expect(result.ok).toBe(true);
    expect(lstatSync(target).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(target, 'SKILL.md'), 'utf8')).toBe('dev');
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
