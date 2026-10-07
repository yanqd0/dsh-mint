/**
 * The panel's route space, shared by both halves of the plugin.
 *
 * The host registers the prefix on `ctx.webServer` and matches names inside it
 * (`src/routes.ts`); the browser half builds the same paths for its `fetch`es
 * (`src/client/api.ts`). This module is the single declaration both derive from,
 * so renaming a route is one edit instead of three.
 *
 * Plain data and pure functions only: the client bundle inlines this module, so
 * it must never reach for a node builtin (which the browser half cannot have).
 */

/**
 * Every route lives under this prefix; one registration owns the whole space.
 *
 * **No trailing slash.** The host matches a `prefix` route with
 * `pathname === prefix || pathname.startsWith(prefix + '/')`, so a registered
 * `/dsh-mint/` would only ever match `/dsh-mint/` or `/dsh-mint//…`: a request
 * for `/dsh-mint/issues` misses it, falls through to the SPA fallback, and comes
 * back as an empty 404.
 */
export const ROUTE_PREFIX = '/dsh-mint';

/** The routes this prefix answers, in host-table order. */
export const ROUTE_NAMES = [
  'issues',
  'plans',
  'milestones',
  'issue',
  'plan',
  'milestone',
  'meta',
  // The plan DAG's read-only view: file-keyed rather than
  // project-keyed, so it takes a session id and spawns no CLI.
  'dag',
] as const;

/** One route's name, as {@link ROUTE_NAMES} declares it. */
export type RouteName = (typeof ROUTE_NAMES)[number];

/** One route's path, as the browser half requests it. */
export function routePath(name: RouteName): string {
  return `${ROUTE_PREFIX}/${name}`;
}

/** True when a path segment names one of {@link ROUTE_NAMES}. */
export function isRouteName(name: string): name is RouteName {
  return (ROUTE_NAMES as readonly string[]).includes(name);
}
