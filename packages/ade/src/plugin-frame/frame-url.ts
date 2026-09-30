/**
 * Where a plugin's frame loads from. WebView2 answers a custom scheme only as `http://<scheme>.localhost`, the other webviews as
 * `<scheme>://localhost` (the same rule as `nikverse/protocol.ts`, and the one `plugin_scheme.rs` registers). The frame is sandboxed without
 * `allow-same-origin`, so this is where its files come from, not what its origin is.
 */

export const PLUGIN_SCHEME = "plugin"

/** The same rule the native side holds ids to (`plugin_scheme::valid_id`). */
const ID = /^[a-z][a-z0-9-]{1,31}$/

export function validPluginId(id: unknown): id is string {
  return typeof id === "string" && ID.test(id)
}

/** The page a plugin's frame starts at. */
export const ENTRY = "index.html"

const isWindowsWebview = () => typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent)

export function pluginOrigin(windows = isWindowsWebview()): string {
  return windows ? `http://${PLUGIN_SCHEME}.localhost` : `${PLUGIN_SCHEME}://localhost`
}

/** The frame's address for one load: the nonce rides in the fragment, which no server and no `Referer` ever sees. */
export function pluginFrameUrl(id: string, nonce: string, windows = isWindowsWebview()): string {
  if (!validPluginId(id)) throw new Error("id di plugin non valido")
  return `${pluginOrigin(windows)}/${id}/${ENTRY}#n=${nonce}`
}
