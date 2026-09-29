import { cpSync, existsSync, lstatSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Skill auto-install (#28) — two triggers share this module:
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
 * byte (a SKILL.md-only check missed `references/` edits — #72); anything else
 * is replaced. Extra files already in the target are tolerated on the skip
 * path, so a user's own additions survive a no-op sync. A target that already
 * IS a symlink is left alone — the dev flow (`scripts/install-dsh.sh`) owns
 * symlinks. Every failure logs one line and returns `{ ok: false }`; it never
 * breaks plugin load or package install.
 */

const DIRNAME = dirname(fileURLToPath(import.meta.url));

export interface InstallResult {
  ok: boolean;
  reason?: string;
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
  return join(dshHome, 'skills', 'mint');
}

/**
 * Every file under `root`, as paths relative to it, sorted.
 *
 * The skill is a tree (SKILL.md + references/), and only SKILL.md is injected
 * into a session while references are read on demand — so a stale reference is
 * invisible to a SKILL.md-only comparison (#72).
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
 * files a user put there, and an orphan reference in the copy is harmless
 * because SKILL.md — always synced — is the only router.
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
 * Sync the bundled skill into the DSH skill directory.
 *
 * Never throws: every failure path returns `{ ok: false, reason }` after one
 * log line, so neither a postinstall nor a plugin load can fail over it.
 */
export function installSkill(
  opts: { dshHome?: string; source?: string; log?: (message: string) => void } = {},
): InstallResult {
  const log = opts.log ?? ((message: string) => process.stderr.write(`${message}\n`));
  const source = opts.source ?? skillSource();
  const target = skillTarget(opts.dshHome ?? resolveDshHome());
  try {
    if (!existsSync(source)) {
      log(`[dsh-mint] skill source missing (${source}) — skipping skill install`);
      return { ok: false, reason: 'source missing' };
    }
    if (existsSync(target)) {
      // the dev symlink (scripts/install-dsh.sh) owns the target — never clobber it
      if (lstatSync(target).isSymbolicLink()) {
        return { ok: true };
      }
      if (isCurrent(source, target)) {
        return { ok: true };
      }
      rmSync(target, { recursive: true, force: true });
    }
    cpSync(source, target, { recursive: true });
    return { ok: true };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    log(`[dsh-mint] skill install failed: ${reason}`);
    return { ok: false, reason };
  }
}
