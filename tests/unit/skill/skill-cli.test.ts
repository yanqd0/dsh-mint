import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { OWNER_MARKER } from '../../../src/skill/install-skill.js';
import { linkSkill, runSkillCli, skillStatus, statusLine, uninstallSkill } from '../../../src/skill/skill-cli.js';

/** Every scratch root this file creates, removed again in `afterAll`. */
const scratchDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mint-cli-'));
  scratchDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

interface Fixture {
  source: string;
  dshHome: string;
  target: string;
}

/** A bundled-skill source tree plus a scratch DSH home. */
function fixture(): Fixture {
  const root = tempDir();
  const source = join(root, 'dist-skill');
  mkdirSync(join(source, 'references'), { recursive: true });
  writeFileSync(join(source, 'SKILL.md'), '---\nname: mint\ndescription: test\n---\n\nbody\n');
  writeFileSync(join(source, 'references', 'a.md'), 'a');
  const dshHome = join(root, 'dsh');
  return { source, dshHome, target: join(dshHome, 'skills', 'mint') };
}

/** A directory that is not this plugin's skill. */
function foreignDir(target: string): void {
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, 'SKILL.md'), '---\nname: someone-elses\n---\nbody\n');
}

interface Run {
  code: number;
  out: string[];
  err: string[];
}

function run(f: Fixture, argv: string[]): Run {
  const out: string[] = [];
  const err: string[] = [];
  const code = runSkillCli(argv, {
    dshHome: f.dshHome,
    source: f.source,
    log: (m) => out.push(m),
    error: (m) => err.push(m),
  });
  return { code, out, err };
}

describe('runSkillCli install modes', () => {
  it('installs the copy form on a bare invocation and always exits 0', () => {
    const f = fixture();

    const first = run(f, []);

    expect(first.code).toBe(0);
    expect(lstatSync(f.target).isDirectory()).toBe(true);
    expect(readFileSync(join(f.target, 'SKILL.md'), 'utf8')).toContain('name: mint');
    expect(existsSync(join(f.target, OWNER_MARKER))).toBe(true);
    expect(existsSync(join(f.target, 'references', 'a.md'))).toBe(true);

    // re-running a current copy stays a no-op success
    expect(run(f, []).code).toBe(0);
    expect(run(f, ['--copy']).code).toBe(0);
  });

  it('links the dev form and reports it', () => {
    const f = fixture();

    const linked = run(f, ['--link']);

    expect(linked.code).toBe(0);
    expect(lstatSync(f.target).isSymbolicLink()).toBe(true);
    expect(readlinkSync(f.target)).toBe(f.source);

    const status = run(f, ['--status']);
    expect(status.code).toBe(0);
    expect(status.out.join('\n')).toContain(`symlink ${f.target}`);
    expect(status.out.join('\n')).toContain(`-> ${f.source}`);
    expect(status.out.join('\n')).toContain('ok');
  });

  // 目录所有权门禁：异主目录必须拒绝接手，只有显式 --force 才接管。
  // 预置带 someone-elses 的 SKILL.md，断言 --copy 退出 1 且内容未动，--force 后才覆盖。
  it('refuses a foreign directory and takes it over with --force', () => {
    const f = fixture();
    foreignDir(f.target);

    const refused = run(f, ['--copy']);
    expect(refused.code).toBe(1);
    expect(readFileSync(join(f.target, 'SKILL.md'), 'utf8')).toContain('someone-elses');

    expect(run(f, ['--copy', '--force']).code).toBe(0);
    expect(readFileSync(join(f.target, 'SKILL.md'), 'utf8')).toContain('name: mint');
  });

  it('reports usage errors with a non-zero code', () => {
    const f = fixture();

    const unknown = run(f, ['--nope']);
    expect(unknown.code).toBe(2);
    expect(unknown.err.join('\n')).toContain('unknown option: --nope');
    expect(unknown.err.join('\n')).toContain('usage:');

    expect(run(f, ['--link', '--copy']).code).toBe(2);
    expect(run(f, ['--help']).code).toBe(0);
    expect(run(f, ['--help']).out.join('\n')).toContain('usage:');
  });
});

describe('runSkillCli removal mode', () => {
  it('removes our copy and stays a success when nothing is left', () => {
    const f = fixture();
    run(f, []);
    expect(existsSync(f.target)).toBe(true);

    const removed = run(f, ['--uninstall']);
    expect(removed.code).toBe(0);
    expect(existsSync(f.target)).toBe(false);

    const again = run(f, ['--uninstall']);
    expect(again.code).toBe(0);
    expect(again.out.join('\n')).toContain('nothing to remove');
  });

  // 卸载只摘自家的链接，绝不碰它指向的源目录（那是开发态的真身）。
  // --link 后跑 --uninstall，断言链接消失、源目录的 SKILL.md 仍可读。
  it('unlinks our symlink without touching the directory it points at', () => {
    const f = fixture();
    run(f, ['--link']);

    const removed = run(f, ['--uninstall']);

    expect(removed.code).toBe(0);
    expect(existsSync(f.target)).toBe(false);
    expect(readFileSync(join(f.source, 'SKILL.md'), 'utf8')).toContain('name: mint');
  });

  it('keeps a foreign directory and exits 1 until forced', () => {
    const f = fixture();
    foreignDir(f.target);

    const kept = run(f, ['--uninstall']);
    expect(kept.code).toBe(1);
    expect(kept.out.join('\n')).toContain("not this plugin's skill directory");
    expect(existsSync(join(f.target, 'SKILL.md'))).toBe(true);

    expect(run(f, ['--uninstall', '--force']).code).toBe(0);
    expect(existsSync(f.target)).toBe(false);
  });

  // 悬空符号链接也算异主路径：不能跟进覆盖、不能当自家副本清掉。
  // 把链接指向不存在的目录后跑 --uninstall，断言退出 1 且链接仍在，--force 才摘。
  it('keeps a dangling symlink and exits 1 until forced', () => {
    const f = fixture();
    mkdirSync(join(f.dshHome, 'skills'), { recursive: true });
    symlinkSync(join(f.dshHome, 'gone'), f.target);

    const kept = run(f, ['--uninstall']);
    expect(kept.code).toBe(1);
    expect(lstatSync(f.target).isSymbolicLink()).toBe(true);

    expect(run(f, ['--uninstall', '--force']).code).toBe(0);
    expect(existsSync(f.target)).toBe(false);
  });
});

describe('skillStatus', () => {
  it('reports absence, stale copies and foreign paths', () => {
    const f = fixture();
    expect(skillStatus({ dshHome: f.dshHome, source: f.source }).form).toBe('absent');
    expect(statusLine(skillStatus({ dshHome: f.dshHome, source: f.source }))).toContain('nothing installed');

    run(f, []);
    const current = skillStatus({ dshHome: f.dshHome, source: f.source });
    expect(current.form).toBe('copy');
    expect(current.inSync).toBe(true);

    writeFileSync(join(f.target, 'references', 'a.md'), 'edited');
    expect(skillStatus({ dshHome: f.dshHome, source: f.source }).inSync).toBe(false);
    expect(statusLine(skillStatus({ dshHome: f.dshHome, source: f.source }))).toContain('stale');

    const dangling = fixture();
    mkdirSync(join(dangling.dshHome, 'skills'), { recursive: true });
    symlinkSync(join(dangling.dshHome, 'gone'), dangling.target);
    const link = skillStatus({ dshHome: dangling.dshHome, source: dangling.source });
    expect(link.form).toBe('symlink');
    expect(link.dangling).toBe(true);
    expect(statusLine(link)).toContain('dangling');
  });

  it('reports a foreign directory instead of a copy', () => {
    const f = fixture();
    foreignDir(f.target);

    const status = skillStatus({ dshHome: f.dshHome, source: f.source });

    expect(status.form).toBe('foreign');
    expect(statusLine(status)).toContain("not this plugin's copy");
  });
});

describe('linkSkill', () => {
  it('is idempotent and never follows an existing link', () => {
    const f = fixture();

    expect(linkSkill({ dshHome: f.dshHome, source: f.source }).reason).toBe('linked');
    const first = readlinkSync(f.target);
    expect(linkSkill({ dshHome: f.dshHome, source: f.source }).reason).toBe('linked');
    expect(readlinkSync(f.target)).toBe(first);
  });

  it('reports a missing source without creating anything', () => {
    const f = fixture();
    const logs: string[] = [];

    const result = linkSkill({
      dshHome: f.dshHome,
      source: join(f.dshHome, 'nope'),
      log: (m) => logs.push(m),
    });

    expect(result.reason).toBe('source missing');
    expect(existsSync(f.target)).toBe(false);
    expect(logs.join('\n')).toContain('source missing');
  });

  it('keeps a foreign directory unless forced', () => {
    const f = fixture();
    foreignDir(f.target);

    expect(linkSkill({ dshHome: f.dshHome, source: f.source }).reason).toBe('kept');
    expect(existsSync(join(f.target, 'SKILL.md'))).toBe(true);

    expect(linkSkill({ dshHome: f.dshHome, source: f.source, force: true }).reason).toBe('linked');
    expect(lstatSync(f.target).isSymbolicLink()).toBe(true);
  });
});

describe('uninstallSkill', () => {
  it('is a no-op when nothing is installed', () => {
    const f = fixture();
    expect(uninstallSkill({ dshHome: f.dshHome }).reason).toBe('absent');
  });
});
