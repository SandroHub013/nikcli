/**
 * The nikcli TUI plugin that tells ADE which conversation the TUI shows.
 *
 * nikcli has no hooks in its config, as Claude Code and codex do, so the
 * report comes from a plugin of its TUI instead. A server plugin would not
 * do: switching tab does not reach the server. The TUI gives its plugins the
 * route on screen, `{ name: "session", params: { sessionID } }`, which moves
 * with `/new`, `/sessions`, a tab and «+ new» alike.
 *
 * The file goes in `<nikcli config>/plugin/tui/`, which the TUI scans for
 * plugins (`plugin/` itself belongs to the server's loader and is not read
 * recursively, so the two never meet). Plain JavaScript with only Node's
 * built-ins: `@nikcli-ai/plugin` is not on npm, and a plugin that needed it
 * would not load.
 *
 * It does nothing unless ADE started this TUI: without `ADE_PANE_ID`,
 * `ADE_SPAWN_NONCE` and `ADE_SESSION_DIR` it returns at once, so a nikcli the
 * user starts by hand, or the one behind ADE's Chat, is left alone. When it
 * runs, it checks the route once a second and writes the report of
 * `agent-link.ts` (`source: "switch"`, with the conversation's folder) when
 * the conversation changes: a poll, because a reactive effect would need the
 * TUI's own `solid-js`. The report is written beside its place and moved in,
 * so ADE never reads half of one. A child conversation is not reported: the
 * pane is the parent's.
 */

/** `HOOK_MARKER` of `agent-hooks.ts`, which imports this module: the tests check they agree. */
const HOOK_MARKER = "ade-agent-session"

/** The plugin's file name: the marker, so ADE finds its own file again. */
export const NIKCLI_PLUGIN_NAME = `${HOOK_MARKER}.js`

/**
 * Where the plugin's text is: `src-tauri/plugins/ade-agent-session.js`,
 * compiled into ADE by Rust (`include_str!` in `agent_link.rs`), which
 * writes that text and no other (ripristino review, BASSO 1). The page only
 * asks for the install or the removal: a compromised page cannot make every
 * nikcli TUI load a program of its choosing. Relative to this module, for
 * the tests.
 */
export const NIKCLI_PLUGIN_SOURCE = "../../src-tauri/plugins/ade-agent-session.js"
