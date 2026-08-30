import { cpSync, existsSync, lstatSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Skill auto-install (#28) — two triggers share this module:
 *
 * 1. `package.json` postinstall runs `node dist/install-skill.js` (npm always
 *    runs it; pnpm 10+ blocks dependency build scripts unless allow-listed, so
 *    this trigger is best-effort under pnpm).
 * 2. The host plugin calls {@link installSkill} from `apply()` on every load —
 *    the guaranteed path for `pnpm add -g dsh-mint`: the first session after
 *    installation copies the bundled skill into the DSH skill directory before
 *    the skill catalog's first collect (the filesystem provider re-reads the
 *    directory per lookup, so the skill is discovered in that same session).
 *
 * Semantics are a content SYNC: a target whose `SKILL.md` already matches the
 * bundled one is left untouched (no churn on every session start); anything
 * else is replaced. A target that already IS a symlink is left alone — the dev
 * flow (`scripts/install-dsh.sh`) owns symlinks. Every failure logs one line
 * and returns `{ ok: false }`; it never breaks plugin load or package install.
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

/** True when the installed SKILL.md already matches the bundled one. */
function isCurrent(source: string, target: string): boolean {
  try {
    return readFileSync(join(target, 'SKILL.md')).equals(readFileSync(join(source, 'SKILL.md')));
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
