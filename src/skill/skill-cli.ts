import {
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  type Stats,
} from 'node:fs';
import { dirname } from 'node:path';

import {
  installSkill,
  looksLikeOurSkill,
  resolveDshHome,
  skillInSync,
  skillSource,
  skillTarget,
} from './install-skill.js';

/**
 * The skill command line (`dist/install-skill.js`) — one implementation of the
 * install forms and their guards, shared by `scripts/install-dsh.sh` and
 * `pnpm skill`.
 *
 * Why the guards live here and not in the shell script: removing the skill must
 * be as safe as installing it (dsh has no plugin uninstall hook, so a leftover
 * copy is normal). Every mode refuses to touch a path it
 * cannot identify as this plugin's own, a symlink is only ever unlinked (never
 * followed), and `--force` is the single way to take such a path over.
 *
 * `uninstallSkill` and `linkSkill` mirror `installSkill`'s ownership rules so
 * that install and removal can never disagree about what is ours.
 */

/** Modes the command line accepts; exactly one may be given. */
const MODES = ['--copy', '--link', '--uninstall', '--status'] as const;

type Mode = (typeof MODES)[number];

const USAGE = 'usage: install-skill.js [--copy|--link|--uninstall|--status] [--force]';

/** Options shared by the tools below. */
export interface SkillOptions {
  /** Harness config root; defaults to `$DSH_HOME` or `~/.dsh`. */
  dshHome?: string | undefined;
  /** Bundled skill directory; defaults to `dist/skill` beside this module. */
  source?: string | undefined;
  /** Take over a target that cannot be identified as this plugin's own. */
  force?: boolean | undefined;
  /** One line per outcome worth explaining. */
  log?: ((message: string) => void) | undefined;
}

/** Outcome of {@link uninstallSkill}. */
export interface SkillRemoval {
  /** Why the target was left alone, or that this plugin's install is gone. */
  reason: 'absent' | 'removed' | 'kept';
}

/** Outcome of {@link linkSkill}. */
export interface SkillLinkResult {
  /** Why no link was created, or that the target now is one. */
  reason: 'linked' | 'kept' | 'source missing';
}

/** The installed skill's shape, as reported by {@link skillStatus}. */
export interface SkillStatus {
  /** `$DSH_HOME/skills/mint`, whether or not anything is there. */
  target: string;
  form: 'absent' | 'symlink' | 'copy' | 'foreign';
  /** Link target, for the symlink form. */
  linkTarget?: string | undefined;
  /** Symlink form: the link does not resolve. */
  dangling?: boolean | undefined;
  /** Copy form: every bundled file matches byte for byte. */
  inSync?: boolean | undefined;
}

/** `lstatSync` without the throw, so a link is reported as a link. */
function lstatOrUndefined(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** True when `target` is a symlink that resolves to this plugin's skill. */
function isOurLink(target: string): boolean {
  return existsSync(target) && looksLikeOurSkill(target);
}

/**
 * Report where the installed skill stands.
 *
 * Reads only: no branch creates, removes or rewrites anything.
 */
export function skillStatus(options: SkillOptions = {}): SkillStatus {
  const target = skillTarget(options.dshHome ?? resolveDshHome());
  const source = options.source ?? skillSource();
  const info = lstatOrUndefined(target);
  if (info === undefined) return { target, form: 'absent' };
  if (info.isSymbolicLink()) {
    return {
      target,
      form: 'symlink',
      linkTarget: readlinkSync(target),
      dangling: !existsSync(target),
    };
  }
  if (info.isDirectory()) {
    if (!looksLikeOurSkill(target)) return { target, form: 'foreign' };
    return { target, form: 'copy', inSync: skillInSync(target, source) };
  }
  return { target, form: 'foreign' };
}

/** One line summarising {@link skillStatus}. */
export function statusLine(status: SkillStatus): string {
  const details: string[] = [];
  if (status.linkTarget !== undefined) details.push(`-> ${status.linkTarget}`);
  if (status.dangling === true) details.push('dangling');
  if (status.form === 'symlink' && status.dangling === false) details.push('ok');
  if (status.inSync !== undefined) details.push(status.inSync ? 'in-sync' : 'stale');
  if (status.form === 'foreign') details.push("not this plugin's copy");
  if (status.form === 'absent') details.push('nothing installed');
  const suffix = details.length > 0 ? ` (${details.join(', ')})` : '';
  return `[dsh-mint] skill ${status.form} ${status.target}${suffix}`;
}

/**
 * Point `$DSH_HOME/skills/mint` at the bundled skill (the dev/dogfood form).
 *
 * Idempotent: an existing symlink that already points at the source is left
 * alone. A foreign directory (or file) is reported and kept; `force` replaces
 * it. Never follows a symlink.
 */
export function linkSkill(options: SkillOptions = {}): SkillLinkResult {
  const log = options.log;
  const source = options.source ?? skillSource();
  const target = skillTarget(options.dshHome ?? resolveDshHome());
  const force = options.force === true;
  try {
    if (!existsSync(source)) {
      log?.(`[dsh-mint] skill source missing (${source}) — cannot link it`);
      return { reason: 'source missing' };
    }
    const existing = lstatOrUndefined(target);
    if (existing !== undefined) {
      if (existing.isSymbolicLink()) {
        if (readlinkSync(target) === source) return { reason: 'linked' };
        // unlink removes the link itself, never the directory it points at
        unlinkSync(target);
      } else if (existing.isDirectory()) {
        if (!force && !looksLikeOurSkill(target)) {
          log?.(
            `[dsh-mint] skill target is not this plugin's copy, left alone (${target}) — use --force to replace it`,
          );
          return { reason: 'kept' };
        }
        rmSync(target, { recursive: true, force: true });
      } else if (!force) {
        log?.(`[dsh-mint] skill target is not a directory, left alone (${target})`);
        return { reason: 'kept' };
      } else {
        unlinkSync(target);
      }
    }
    mkdirSync(dirname(target), { recursive: true });
    symlinkSync(source, target);
    log?.(`[dsh-mint] linked ${source} -> ${target}`);
    return { reason: 'linked' };
  } catch (error) {
    log?.(`[dsh-mint] skill link failed: ${messageOf(error)}`);
    return { reason: 'kept' };
  }
}

/**
 * Remove what this plugin installed at `$DSH_HOME/skills/mint`.
 *
 * Idempotent (absent is success) and guarded: a foreign directory or file is
 * reported and kept, a symlink is unlinked without following it, and a link
 * that cannot be confirmed as this plugin's own is only removed with `force`.
 * Never throws.
 */
export function uninstallSkill(options: SkillOptions = {}): SkillRemoval {
  const log = options.log;
  const target = skillTarget(options.dshHome ?? resolveDshHome());
  const force = options.force === true;
  const existing = lstatOrUndefined(target);
  if (existing === undefined) {
    log?.(`[dsh-mint] nothing to remove (${target})`);
    return { reason: 'absent' };
  }
  try {
    if (existing.isSymbolicLink()) {
      if (!force && !isOurLink(target)) {
        log?.(
          `[dsh-mint] kept ${target}: it does not resolve to this plugin's skill — use --force to unlink it anyway`,
        );
        return { reason: 'kept' };
      }
      // unlink removes the link itself, never the directory it points at
      unlinkSync(target);
    } else if (existing.isDirectory()) {
      if (!force && !looksLikeOurSkill(target)) {
        log?.(`[dsh-mint] kept ${target}: it is not this plugin's skill directory`);
        return { reason: 'kept' };
      }
      rmSync(target, { recursive: true, force: true });
    } else if (!force) {
      log?.(`[dsh-mint] kept ${target}: it is not this plugin's skill directory`);
      return { reason: 'kept' };
    } else {
      unlinkSync(target);
    }
  } catch (error) {
    log?.(`[dsh-mint] skill removal failed (${target}): ${messageOf(error)}`);
    return { reason: 'kept' };
  }
  log?.(`[dsh-mint] removed installed skill: ${target}`);
  return { reason: 'removed' };
}

/** Output sinks for {@link runSkillCli}; the defaults write to stdout/stderr. */
export interface SkillCliIo extends SkillOptions {
  /** Usage and refusals; defaults to stderr. */
  error?: ((message: string) => void) | undefined;
}

/**
 * Run the skill command line and return the process exit code.
 *
 * A **bare** invocation only installs (the copy form, the packaged-install
 * shape) and always answers 0: skill installation is best-effort and must never
 * fail `pnpm install`. Explicit modes carry a real code instead, so a
 * script can tell a guarded refusal (1) from success (0); a usage error is 2.
 *
 * @param argv - arguments without the `node script` prefix.
 * @param io - sinks and path overrides; tests inject a scratch `dshHome`.
 * @returns the exit code for this invocation.
 */
export function runSkillCli(argv: readonly string[], io: SkillCliIo = {}): number {
  const log = io.log ?? ((message: string) => process.stdout.write(`${message}\n`));
  const error = io.error ?? ((message: string) => process.stderr.write(`${message}\n`));
  if (argv.includes('-h') || argv.includes('--help')) {
    log(USAGE);
    return 0;
  }
  const unknown = argv.filter((arg) => arg !== '--force' && !(MODES as readonly string[]).includes(arg));
  if (unknown.length > 0) {
    error(`unknown option: ${unknown[0]}`);
    error(USAGE);
    return 2;
  }
  const modes = argv.filter((arg): arg is Mode => (MODES as readonly string[]).includes(arg));
  if (modes.length > 1) {
    error(`only one mode at a time: ${modes.join(' ')}`);
    error(USAGE);
    return 2;
  }
  const mode = modes[0];
  const force = argv.includes('--force');
  const common: SkillOptions = { dshHome: io.dshHome, source: io.source, force, log };
  if (mode === '--status') {
    log(statusLine(skillStatus({ dshHome: io.dshHome, source: io.source })));
    return 0;
  }
  if (mode === '--uninstall') {
    const removal = uninstallSkill(common);
    return removal.reason === 'kept' ? 1 : 0;
  }
  if (mode === '--link') {
    return linkSkill(common).reason === 'linked' ? 0 : 1;
  }
  // Bare invocation and `--copy`: install (or re-sync) the whole tree.
  const installed = installSkill(common);
  if (mode === undefined) return 0; // best-effort install: never fail the caller
  return installed.ok ? 0 : 1;
}
