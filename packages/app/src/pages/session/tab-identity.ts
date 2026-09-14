/**
 * What a tab id means.
 *
 * The identifiers were already half a URI scheme — `file://…` and `browser://…`
 * carry one, while `review`, `context` and `empty` are bare words — so every
 * call site that needed to know what it was holding wrote its own `startsWith`
 * or `=== "review"` check. Twenty-two of them had accumulated across nine files,
 * and the disagreements between them are what let a tab be active while nothing
 * could render it.
 *
 * This is the single place that answers "what is this tab". It is deliberately
 * total: an id that matches nothing known is still classified, as `unknown`,
 * rather than falling through whichever branch happened to come last.
 */

export type TabIdentity =
  | { kind: "file"; path: string }
  | { kind: "browser"; url?: string }
  | { kind: "review" }
  | { kind: "context" }
  | { kind: "empty" }
  | { kind: "unknown" }

export const FILE_SCHEME = "file://"
export const BROWSER_SCHEME = "browser://"

/** The visual editor's tab. One panel with its own address bar, so one id. */
export const BROWSER_TAB = "browser"

export function parseTab(id: string): TabIdentity {
  if (id.startsWith(FILE_SCHEME)) return { kind: "file", path: id.slice(FILE_SCHEME.length) }
  if (id.startsWith(BROWSER_SCHEME)) return { kind: "browser", url: id.slice(BROWSER_SCHEME.length) }
  if (id === "browser") return { kind: "browser" }
  if (id === "review") return { kind: "review" }
  if (id === "context") return { kind: "context" }
  if (id === "empty") return { kind: "empty" }
  return { kind: "unknown" }
}

/**
 * Tabs that exist without being members of the open-file list: they are owned by
 * their own toggles, so a list rewrite can never orphan them.
 */
export function isPseudoTab(id: string): boolean {
  const kind = parseTab(id).kind
  return kind !== "file" && kind !== "unknown"
}

export function isFileTab(id: string): boolean {
  return parseTab(id).kind === "file"
}

export function isBrowserTab(id: string): boolean {
  return parseTab(id).kind === "browser"
}
