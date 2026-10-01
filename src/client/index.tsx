/**
 * Browser half of dsh-mint — the entry of the prebuilt client bundle.
 *
 * `scripts/build-client.mjs` wraps this module into the factory the DSH client
 * module system loads:
 *
 *     window.__ModuleLoader__.load({ id: '@yanqd0/dsh-mint', factory: (require) => { … } })
 *
 * Everything outside the shell's frozen module table must stay `external`, so
 * this file may import React and `@deepseek-ai/dsh-client-ui-primitives` but
 * nothing else: `dsh.client.inject` only orders *other plugin bundles*, while
 * an undeclared module request fails at materialization.
 *
 * #9 ships the packaging channel; #11 adds the right-sidebar tab type, its
 * dictionary, and its body seat here.
 */

/**
 * Client services this plugin waits for before `apply` runs.
 *
 * Declaring them is what keeps the bundle safe in every composition: where one
 * never appears (a host without the right sidebar), the plugin stays pending
 * instead of throwing.
 */
export const inject = ['slots', 'locale', 'sidebarRightTabs'];

/** Client plugin body. */
export function apply(): void {
  // #11 registers the `mint` tab type, its `zh` dictionary, and the
  // `sidebar.right.pane.tab` body here.
}
