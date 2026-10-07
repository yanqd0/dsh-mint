import { projectCacheKey } from './cross-project.js';

/**
 * The project a session's cwd already resolves to (#114).
 *
 * `-p <项目>` is only *cross-project* when `<项目>` is not the project the
 * session's own directory resolves to. mint has no "which project am I in?"
 * query — and this plugin must not read mint's database — but every
 * `list --json` item carries the resolved `project` name, and the overview
 * channel already runs exactly that call once per session. The answer is
 * remembered here so the cross-project gate and the `mint` tool can compare
 * against it without a second spawn.
 *
 * Keyed by `entry + cwd`, matching the project-list memo: a different
 * `mintEntry` can resolve a different project for the same directory.
 *
 * **No TTL.** The cwd → project mapping is stable for the life of a session,
 * and a TTL short enough to be safe would expire between the once-per-session
 * overview and the tool calls that need it. `project create` / `project set`
 * *can* change the mapping, so {@link resetOwnProjectCache} is called from the
 * same place as the project-list reset (`executeMintTool`).
 *
 * An **unknown** name is a real answer and callers must treat it as such: the
 * gate keeps asking (fail-closed) and the tool stays silent, so a missing
 * overview can never turn a cross-project write into a silent one.
 */

/** How many cwd/entry pairs are remembered; matches the other bounded maps. */
export const MAX_OWN_PROJECTS = 100;

/** Remembered cwd/entry → project name, insertion order (oldest first). */
const ownProjects = new Map<string, string>();

/** Record the project name the overview resolved for a session directory. */
export function noteOwnProject(cwd: string, entry: string | undefined, name: string): void {
  const key = projectCacheKey(cwd, entry);
  // Re-insert so an updated name also moves to the freshest position.
  ownProjects.delete(key);
  if (ownProjects.size >= MAX_OWN_PROJECTS) {
    const oldest = ownProjects.keys().next().value;
    if (oldest !== undefined) ownProjects.delete(oldest);
  }
  ownProjects.set(key, name);
}

/**
 * The project name this directory resolves to, or `undefined` when no overview
 * has learned it yet. `undefined` means "unknown", never "some other project":
 * callers fail closed on it.
 */
export function ownProjectOf(cwd: string, entry: string | undefined): string | undefined {
  return ownProjects.get(projectCacheKey(cwd, entry));
}

/** True when `project` is the session's own project, as far as we know. */
export function isOwnProject(cwd: string, entry: string | undefined, project: string): boolean {
  const own = ownProjectOf(cwd, entry);
  return own !== undefined && own === project;
}

/** Forget every remembered mapping (`project create`/`set`, and tests). */
export function resetOwnProjectCache(): void {
  ownProjects.clear();
}
