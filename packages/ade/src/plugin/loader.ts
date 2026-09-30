/**
 * Turning a resolved plugin entrypoint into a live module — which this build
 * does not do, and says so.
 *
 * The step it replaces imported a file of the repository with
 * `convertFileSrc` plus `import()`, inside ADE's own origin. Two things are
 * true at once and neither is a detail: without Tauri's asset protocol the
 * import cannot succeed at all (with the window's CSP as it stands, nothing
 * loads), and enabling that protocol is the repair that costs more than the
 * failure. A cloned repository's `.nikcli/tui.json` would then be one consent
 * dialog away from code running with ADE's ~110 IPC commands behind it — pty,
 * files, secrets — because the origin is the application's.
 *
 * So the loader refuses before it looks at anything, with a sentence the
 * plugin manager shows on the plugin's own row, where today's load error
 * used to be. What makes it a block rather than a bug is that nothing here
 * can be enabled by a flag: `discovery.ts` still finds these plugins and the
 * built-in manager still lists them, and the refusal is what the user reads.
 *
 * The condition on the box says it: file plugins come back when the iframe
 * sandbox exists, so a plugin runs in an origin with no IPC commands in it
 * at all. Until then this is the whole of the loader, and the test beside it
 * (`loader.test.ts`) fails if the asset protocol is switched on in Rust or in
 * `tauri.conf.json` to make an import work again.
 */

/**
 * What the plugin manager shows in place of a load error, and what
 * `importPluginModule` throws. Italian: it reaches the user.
 */
export const FILE_PLUGIN_DISABLED_REASON =
  "i plugin di progetto da file sono disattivati finché non esiste il sandbox in iframe"

/**
 * The switch, read by the workbench so the consent dialog is not opened for
 * code that is refused before it could run. It flips back with the sandbox:
 * the loader, this flag and the consent question move together.
 */
export const FILE_PLUGINS_DISABLED = true

/**
 * Refuses, without importing anything.
 *
 * The argument is kept because the runtime's `load` takes it; it is not read,
 * and the message does not name the file, because the reason is the same for
 * every project plugin and the row is keyed by the spec the user wrote.
 */
export async function importPluginModule(_entry: string): Promise<Record<string, unknown>> {
  throw new Error(FILE_PLUGIN_DISABLED_REASON)
}
