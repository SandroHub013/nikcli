import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import postcss, { type Rule } from "postcss"

/**
 * The press of nik's restyle (99ade0287), on our tokens.
 *
 * Upstream gave these buttons a `scale(0.95–0.98)` on `:active` and a transition
 * that carries it. The merge kept our sheets, so the feel came back here as
 * `var(--ade-press)`: one value, and none under reduced motion. Rows (nik's
 * 0.99), hover growths, the window buttons (they dim, as Windows does) and the
 * pane header's 18px buttons stay still on purpose.
 */
const PRESSED = [
  '[data-slot="agent-action"]:active',
  '[data-slot="bots-new"]:active',
  '[data-slot="browser-nav-btn"]:active:not(:disabled)',
  '[data-slot="browser-mode-btn"]:active',
  '[data-slot="browser-device-btn"]:active',
  '[data-slot="browser-rotate-btn"]:active',
  '[data-slot="browser-owner"]:active',
  '[data-slot="browser-owner-menu"] button:active',
  '[data-slot="browser-send-choice"]:active',
  '[data-slot="browser-action"]:active',
  '[data-slot="browser-context-action"]:active',
  '[data-slot="browser-context-remove"]:active',
  '[data-slot="browser-clear-selection"]:active',
  '[data-slot="browser-send-btn"]:not(:disabled):active',
  '[data-slot="chat-action"]:active',
  '[data-slot="chat-copy"]:active',
  '[data-slot="sheet-close"]:active',
  '[data-slot="decision-submit"]:active:not(:disabled)',
  '[data-slot="decision-ghost"]:active:not(:disabled)',
  '[data-slot="decision-chip"]:active:not(:disabled)',
  '[data-slot="ade-icon"]:active',
  '[data-slot="ext-filter"]:active',
  '[data-slot="ade-rec"]:active',
  '[data-component="remote-space"] [data-slot="primary"]:active',
  '[data-component="remote-space"] [data-slot="secondary"]:active',
  '[data-slot="keys-agent"]:active',
  '[data-slot="new-close"]:active',
  '[data-slot="new-cancel"]:active',
  '[data-slot="new-agent"]:active:not(:disabled)',
  '[data-slot="new-count"]:active',
  '[data-slot="hook-action"]:active:not(:disabled)',
  '[data-slot="section-add"]:active',
  '[data-slot="sidebar-settings"]:active',
  '[data-slot="empty-action-btn"]:active',
  '[data-slot="search-clear"]:active',
  '[data-slot="search-kind"]:active',
  '[data-slot="sim-button"]:active:not(:disabled)',
  '[data-slot="video-open"]:active',
  '[data-slot="video-button"]:active',
]

const SRC = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")

function sheets(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...sheets(path))
    else if (entry.name.endsWith(".css")) found.push(path)
  }
  return found
}

/* Top-level rules only: a reduced-motion block turning a transition off is not the element's transition. */
const RULES: Rule[] = sheets(SRC).flatMap((path) =>
  postcss.parse(readFileSync(path, "utf8")).nodes.filter((node): node is Rule => node.type === "rule"),
)
const one = (selector: string) => selector.split(/\s+/).join(" ").trim()
const declared = (selector: string, prop: string) =>
  RULES.filter((rule) => rule.selectors.map(one).includes(selector)).flatMap((rule) =>
    rule.nodes.flatMap((node) => (node.type === "decl" && node.prop === prop ? [node.value] : [])),
  )

describe("the press nik's restyle gave a button", () => {
  for (const selector of PRESSED) {
    const ground = selector.replace(/:active|:not\(:disabled\)/g, "")

    test(`${selector} presses with the token`, () => {
      expect(declared(selector, "transform")).toEqual(["var(--ade-press)"])
    })

    test(`${ground} transitions the press`, () => {
      const last = declared(ground, "transition").at(-1) ?? ""
      expect(last).toMatch(/var\(--ade-btn-transition\)|\btransform\b/)
    })
  }
})

/*
 * The other half of the restyle: fields, rows and links that changed ground,
 * border or colour in a snap. They ease now, with what nik eased, minus the
 * transform on rows (they do not move here) and the filter on the sidebar pill
 * and space badge (we hover with the ground, not brightness).
 */
const EASED: Record<string, string[]> = {
  '[data-slot="browser-edit-field"] input': ["border-color", "box-shadow"],
  '[data-slot="decision-option"]': ["background", "border-color"],
  '[data-slot="decision-note"]': ["border-color", "box-shadow"],
  '[data-slot="decision-row"]': ["border-color", "background"],
  '[data-slot="ext-search"]': ["border-color", "background"],
  '[data-slot="ext-card"]': ["border-color", "box-shadow"],
  '[data-slot="ext-link"]': ["color"],
  '[data-slot="drop-zone-label"]': ["background"],
  '[data-component="remote-space"] input': ["border-color", "background", "box-shadow"],
  '[data-component="remote-space"] [data-slot="host"]': ["background"],
  '[data-slot="keys-row"]': ["background"],
  '[data-slot="keys-field"] input': ["border-color", "background", "box-shadow"],
  '[data-slot="session-mark-wrap"]': ["background"],
  '[data-slot="session-title"]': ["color"],
  '[data-slot="active-agent-title"]': ["color"],
  '[data-component="ade-sidebar"] [data-slot="session-row"]': ["background"],
  '[data-component="ade-sidebar"] [data-slot="active-agent-card"]': ["background"],
  '[data-slot="sidebar-stat"]': ["color"],
  '[data-slot="sidebar-stat-icon"]': ["color"],
  '[data-slot="sim-url"]': ["border-color"],
  '[data-slot="sim-device"]': ["border-color"],
}

describe("what nik's restyle eased", () => {
  for (const [selector, props] of Object.entries(EASED)) {
    test(`${selector} eases ${props.join(", ")} on the shared timing`, () => {
      const last = declared(selector, "transition").at(-1) ?? ""
      for (const prop of props) expect(last).toContain(`${prop} var(--ade-dur-fast)`)
    })
  }
})
