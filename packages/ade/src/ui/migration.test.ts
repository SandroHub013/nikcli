import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import postcss, { type Rule } from "postcss"

/**
 * Which buttons have moved onto the shared primitives, and which sheets no longer carry a copy of them.
 *
 * Read from the sources, because the claim is about how a surface is written: a `<button data-slot="x">` that
 * comes back is a button with its own height, radius, ground, press and disabled look again (DS-8). Each surface
 * lists the slots that are `Button` or `IconButton` now, and the declarations its sheet must not repeat.
 */
const SRC = new URL("..", import.meta.url)
const read = (path: string) => readFileSync(new URL(path, SRC), "utf8").replace(/\r\n/g, "\n")
const withoutComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "")

/** Every file under `src` with the extension, tests excluded. */
function files(dir: string, ext: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...files(path, ext))
    else if (entry.name.endsWith(ext) && !entry.name.endsWith(`.test${ext}`)) found.push(path)
  }
  return found
}

const ROOT = decodeURIComponent(SRC.pathname).replace(/^\/([A-Za-z]:)/, "$1")

/**
 * The `<button ...>` opening tags of a TSX source, read with the braces counted: an attribute can hold `=>` or `>`
 * inside `{...}`, and a pattern that stops at the first `>` never sees a slot written after an `onClick`.
 */
export function buttonTags(source: string, name = "button"): string[] {
  const tags: string[] = []
  for (let at = source.indexOf(`<${name}`); at >= 0; at = source.indexOf(`<${name}`, at + 1)) {
    if (!/[\s>]/.test(source[at + name.length + 1] ?? "")) continue
    let depth = 0
    for (let i = at; i < source.length; i++) {
      const c = source[i]
      if (c === "{") depth++
      else if (c === "}") depth--
      else if (c === ">" && depth === 0 && source[i - 1] !== "=") {
        tags.push(source.slice(at, i + 1))
        break
      }
    }
  }
  return tags
}

/** The rules of a sheet that name a slot anywhere in their selector list, comments stripped. */
function rulesFor(css: string, slot: string): Rule[] {
  const found: Rule[] = []
  postcss.parse(withoutComments(css)).walkRules((rule) => {
    if (rule.selectors.some((selector) => selector.includes(`[data-slot="${slot}"]`))) found.push(rule)
  })
  return found
}

interface Surface {
  name: string
  /** Files where the slots are drawn. */
  tsx: string[]
  /** Slots that are a primitive now: no raw `<button>` may carry them. */
  slots: string[]
  css: string[]
}

const SURFACES: Surface[] = [
  {
    name: "the session launcher",
    tsx: ["session-new/session-new.tsx", "session-new/install-panel.tsx"],
    slots: ["new-cancel", "new-launch-btn", "new-close", "install-close", "install-copy", "install-run", "install-recheck", "install-page"],
    css: ["session-new/session-new.css"],
  },
  {
    name: "the bots",
    tsx: [
      "bots/bots.tsx",
      "bots/confirm.tsx",
      "bots/memory-panel.tsx",
      "bots/room-panel.tsx",
      "bots/routine-panel.tsx",
      "bots/spend-panel.tsx",
      "bots/waiting-list.tsx",
    ],
    slots: ["bots-btn"],
    css: ["bots/bots.css"],
  },
  {
    name: "decisions, design, the consent and update dialogs and the empty project screen",
    tsx: [
      "decisions/decision-card.tsx",
      "decisions/decisions-pane.tsx",
      "record/consent-dialog.tsx",
      "update/update-dialog.tsx",
      "design/design-card.tsx",
      "design/design-pane.tsx",
      "surface/empty-project.tsx",
    ],
    slots: ["decision-submit", "decision-ghost", "design-submit", "empty-action"],
    css: ["decisions/decisions.css", "design/design.css", "dev.css"],
  },
  {
    name: "the sidebar",
    tsx: ["sidebar/sidebar.tsx"],
    slots: ["workspace-open-project", "section-add", "empty-action-btn", "search-clear"],
    css: ["sidebar/sidebar.css"],
  },
  {
    name: "settings",
    tsx: ["settings/shell.tsx", "settings/account.tsx", "settings/sections.tsx"],
    slots: ["settings-check-update", "settings-close", "settings-done", "switch-continue", "switch-cancel"],
    css: ["settings/shell.css", "settings/sections.css"],
  },
]

const MIGRATED = SURFACES.flatMap((surface) => surface.slots)

describe("the shared Button and IconButton", () => {
  test("the tag scanner reads past an arrow in an attribute", () => {
    const tags = buttonTags(`<button type="button" onClick={() => go(a > b)} data-slot="late">x</button>`)
    expect(tags).toHaveLength(1)
    expect(tags[0]).toContain('data-slot="late"')
    // A longer tag name is not a button.
    expect(buttonTags("<buttons data-slot='x'>")).toEqual([])
  })

  test("no .tsx anywhere in src draws a migrated slot as a raw <button>", () => {
    const raw: string[] = []
    for (const file of files(ROOT, ".tsx")) {
      const source = withoutComments(readFileSync(file, "utf8").replace(/\r\n/g, "\n"))
      for (const tag of buttonTags(source)) {
        for (const slot of MIGRATED) if (tag.includes(`data-slot="${slot}"`)) raw.push(`${file.slice(ROOT.length)} ${slot}`)
      }
    }
    expect(raw).toEqual([])
  })
})

for (const surface of SURFACES) {
  describe(`${surface.name} is on the shared Button`, () => {
    test("its sheet no longer redraws the button, wherever the slot sits in a selector list", () => {
      for (const file of surface.css) {
        const css = read(file)
        for (const slot of surface.slots) {
          for (const rule of rulesFor(css, slot)) {
            const redrawn = rule.nodes.some(
              (node) => node.type === "decl" && /^(height|min-height|border-radius|background|border|font-size|font-weight)$/.test(node.prop),
            )
            expect({ file, slot, selector: rule.selector, redrawn }).toEqual({ file, slot, selector: rule.selector, redrawn: false })
          }
        }
      }
    })
  })
}

describe("the sheets' and panes' empty views are the shared EmptyState", () => {
  test("no hand-built sheet-empty <div> with a bold title and a span is left", () => {
    for (const file of [
      "decisions/decisions-pane.tsx",
      "design/design-pane.tsx",
      "decisions/decisions-sheet.tsx",
      "design/design-sheet.tsx",
    ]) {
      const source = withoutComments(read(file))
      expect({ file, built: /<div data-slot="sheet-empty">/.test(source) }).toEqual({ file, built: false })
      expect({ file, uses: source.includes("<EmptyState data-slot=\"sheet-empty\"") }).toEqual({ file, uses: true })
    }
  })
})

describe("choices Master made on the review (2026-11-02), kept so a later edit does not undo them silently", () => {
  test("the settings Done is a secondary large button, not the screen's one primary", () => {
    const [done] = buttonTags(read("settings/shell.tsx"), "Button").filter((tag) => tag.includes('data-slot="settings-done"'))
    expect(done).toContain('variant="secondary"')
    expect(done).toContain('size="lg"')
    expect(done).not.toContain('variant="primary"')
  })

  test("a ghost beside a decision's submit is as tall as it: no size=\"sm\" there", () => {
    const source = withoutComments(read("decisions/decisions-pane.tsx"))
    const tags = buttonTags(source, "Button")
    const beside = tags.filter((tag) => tag.includes('data-slot="decision-ghost"'))
    expect(beside.length).toBeGreaterThan(0)
    // The two ghosts that follow a submit (the reopen and the recipient confirmations) are full height; the two inside a
    // decision row, with no submit beside them, stay small.
    const full = beside.filter((tag) => !tag.includes('size="sm"'))
    expect(full).toHaveLength(2)
    for (const tag of full) {
      const before = source.slice(0, source.indexOf(tag))
      expect(before.lastIndexOf('data-slot="decision-submit"')).toBeGreaterThan(before.lastIndexOf('data-slot="decision-ghost"'))
    }
    expect(beside.filter((tag) => tag.includes('size="sm"'))).toHaveLength(beside.length - 2)
  })

  test("the decisions and design empty views are centred like every other empty view", () => {
    const decisions = postcss.parse(withoutComments(read("decisions/decisions.css")))
    decisions.walkRules((rule) => {
      if (!rule.selectors.includes('[data-slot="sheet-empty"]')) return
      for (const node of rule.nodes) {
        if (node.type === "decl") expect({ selector: rule.selector, prop: node.prop }).not.toEqual({ selector: rule.selector, prop: expect.stringMatching(/^(align-items|text-align)$/) })
      }
    })
    expect(withoutComments(read("ui/empty-icon.css"))).not.toMatch(/sheet-empty[^{]*empty-icon[^{]*\{[^}]*margin-inline/)
  })
})
