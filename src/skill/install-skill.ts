import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Skill auto-install — two triggers share this module:
 *
 * 1. `package.json` postinstall runs `node dist/install-skill.js` (npm always
 *    runs it; pnpm 10+ blocks dependency build scripts unless allow-listed, so
 *    this trigger is best-effort under pnpm).
 * 2. The host plugin calls {@link installSkill} from `apply()` on every load —
 *    the guaranteed path for `pnpm add -g @yanqd0/dsh-mint`: the first session
 *    after installation copies the bundled skill into the DSH skill directory
 *    before the skill catalog's first collect (the filesystem provider re-reads
 *    the directory per lookup, so the skill is discovered in that same
 *    session).
 *
 * Semantics are a content SYNC over the **whole skill tree**: the target is
 * untouched only when every file in the bundled skill already matches byte for
 * byte (a SKILL.md-only check would miss `references/` edits); anything else
 * is replaced. Extra files already in the target are tolerated on the skip
 * path, so a user's own additions survive a no-op sync.
 *
 * Ownership — this module only ever touches the copy **it** installed:
 *
 * - a copy carries {@link OWNER_MARKER}; a copy made before that marker existed
 *   is recognised by its `SKILL.md` frontmatter. Anything else (a foreign
 *   directory, a regular file) is reported once and left alone, and only an
 *   explicit `force` takes it over;
 * - a symlink target is never followed or clobbered: the dev flow
 *   (`scripts/install-dsh.sh --link`) owns symlinks, so a dangling or foreign
 *   one is reported instead of repaired — `force` unlinks it first.
 *
 * Every failure logs one line and returns `{ ok: false }`; it never breaks
 * plugin load or package install.
 */

const DIRNAME = dirname(fileURLToPath(import.meta.url));

/** Skill name: the directory under `$DSH_HOME/skills` and the frontmatter `name`. */
export const SKILL_NAME = 'mint';

/**
 * Marker file written into an installed copy.
 *
 * Ownership has to be answerable *positively* before anything is deleted, and a
 * copy interrupted mid-sync may have no `SKILL.md` yet — so the marker goes in
 * first and identifies the directory even then.
 */
export const OWNER_MARKER = '.dsh-mint-skill';

/** Marker body; the reader only checks that the file exists. */
const OWNER_MARKER_CONTENT = '@yanqd0/dsh-mint\n';

export interface InstallResult {
  ok: boolean;
  reason?: string;
}

/** Options for {@link installSkill}. */
export interface InstallOptions {
  /** Harness config root; defaults to `$DSH_HOME` or `~/.dsh`. */
  dshHome?: string | undefined;
  /** Bundled skill directory; defaults to `dist/skill` beside this module. */
  source?: string | undefined;
  /** Take over a target that cannot be identified as this plugin's own. */
  force?: boolean | undefined;
  /** One line per outcome worth explaining. */
  log?: ((message: string) => void) | undefined;
}

/** DSH_HOME from the environment, else `~/.dsh` — mirrors scripts/install-dsh.sh. */
export function resolveDshHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.DSH_HOME ?? join(homedir(), '.dsh');
}

/** The bundled skill directory: `dist/skill`, beside this module. */
export function skillSource(): string {
  return join(DIRNAME, 'skill');
}

/** The discovery target `dsh-skill-filesystem` reads. */
export function skillTarget(dshHome: string): string {
  return join(dshHome, 'skills', SKILL_NAME);
}

/**
 * The `name` of a skill file's leading frontmatter block, or `undefined` when it
 * does not parse.
 *
 * Only the first `name:` line of that block is read; this identifies an
 * installation, it does not validate a skill file.
 */
export function frontmatterName(raw: string): string | undefined {
  const block = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw)?.[1];
  if (block === undefined) return undefined;
  const value = /^\s*name:\s*(.+?)\s*$/mu.exec(block)?.[1];
  if (value === undefined) return undefined;
  return value.replace(/^(['"])(.*)\1$/u, '$2');
}

/**
 * True when `dir` is a copy this plugin installed.
 *
 * Positive identification only, so a guard never deletes something foreign: the
 * marker written by {@link installSkill}, or — for a copy from before the
 * marker — a `SKILL.md` whose frontmatter names this skill. An unreadable or
 * dangling path answers `false`, which only ever means "leave it alone".
 */
export function looksLikeOurSkill(dir: string): boolean {
  try {
    readFileSync(join(dir, OWNER_MARKER));
    return true;
  } catch {
    // no marker: fall back to the frontmatter of a pre-marker copy
  }
  try {
    return frontmatterName(readFileSync(join(dir, 'SKILL.md'), 'utf8')) === SKILL_NAME;
  } catch {
    return false;
  }
}

/**
 * Every file under `root`, as paths relative to it, sorted.
 *
 * The skill is a tree (SKILL.md + references/), and only SKILL.md is injected
 * into a session while references are read on demand — so a stale reference is
 * invisible to a SKILL.md-only comparison.
 */
function listFiles(root: string, base: string = root): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(full, base));
    } else if (entry.isFile()) {
      files.push(relative(base, full));
    }
  }
  return files.sort();
}

/**
 * True when every bundled file already exists in the target with identical
 * bytes.
 *
 * Extra target files are deliberately ignored: the skip path must never delete
 * files a user put there (the ownership marker among them), and an orphan
 * reference in the copy is harmless because SKILL.md — always synced — is the
 * only router.
 */
function isCurrent(source: string, target: string): boolean {
  try {
    for (const file of listFiles(source)) {
      const matches = readFileSync(join(source, file)).equals(readFileSync(join(target, file)));
      if (!matches) return false;
    }
    return true;
  } catch {
    // unreadable or partial installs are never "current"
    return false;
  }
}

/**
 * True when `target` already holds every bundled file byte for byte.
 *
 * Exported for the status view (`dist/install-skill.js --status`), so "is the
 * copy stale?" has one answer for both the sync and the report.
 */
export function skillInSync(target: string, source: string = skillSource()): boolean {
  return isCurrent(source, target);
}

/** `lstatSync` without the throw: the shape check must see symlinks as links. */
function lstatOrUndefined(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}

/**
 * Sync the bundled skill into the DSH skill directory.
 *
 * Never throws: every failure path returns `{ ok: false, reason }` after one
 * log line, so neither a postinstall nor a plugin load can fail over it.
 */
export function installSkill(opts: InstallOptions = {}): InstallResult {
  const log = opts.log ?? ((message: string) => process.stderr.write(`${message}\n`));
  const source = opts.source ?? skillSource();
  const target = skillTarget(opts.dshHome ?? resolveDshHome());
  const force = opts.force === true;
  try {
    if (!existsSync(source)) {
      log(`[dsh-mint] skill source missing (${source}) — skipping skill install`);
      return { ok: false, reason: 'source missing' };
    }
    const existing = lstatOrUndefined(target);
    if (existing !== undefined) {
      if (existing.isSymbolicLink()) {
        if (!force) {
          // the dev flow (scripts/install-dsh.sh) owns symlinks — never clobber one
          if (existsSync(target)) {
            return { ok: true, reason: 'symlink' };
          }
          log(
            `[dsh-mint] skill target is a dangling symlink (${target}) — repoint or remove it, then reload`,
          );
          return { ok: false, reason: 'dangling symlink' };
        }
        // unlink removes the link itself, never the directory it points at
        unlinkSync(target);
      } else if (existing.isDirectory()) {
        if (!force) {
          if (!looksLikeOurSkill(target)) {
            log(
              `[dsh-mint] skill target is not this plugin's copy, left alone (${target}) — use --force to replace it`,
            );
            return { ok: false, reason: 'foreign skill' };
          }
          if (isCurrent(source, target)) {
            return { ok: true };
          }
        }
        rmSync(target, { recursive: true, force: true });
      } else {
        if (!force) {
          log(`[dsh-mint] skill target is not a directory, left alone (${target})`);
          return { ok: false, reason: 'not a directory' };
        }
        unlinkSync(target);
      }
    }
    // The marker goes in before the content, so an interrupted sync stays
    // identifiable as this plugin's copy and is repaired on the next load.
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, OWNER_MARKER), OWNER_MARKER_CONTENT);
    cpSync(source, target, { recursive: true });
    return { ok: true };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    log(`[dsh-mint] skill install failed: ${reason}`);
    return { ok: false, reason };
  }
}
