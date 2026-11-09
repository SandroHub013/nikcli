import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import postcss from "postcss"

/*
 * Review of ade/aspetto-due (Opus), after DS2-7. Read from the sheets: happy-dom does not lay out or cascade.
 *
 * B1: the pane note lost its opaque ground when it took the shared Notice's tone, which is a 10% amber wash. On a short
 * pane the note floats over the terminal's top rows, and the terminal's text showed through it. The voice note already
 * lays its wash over an opaque layer (index.css); the pane's note does the same.
 * Height: the close became a 20px IconButton where it was 13px of text, so a one-line note grew by about 3.5px.
 * Old rules: `bots.css` and `chat.css` still restyled the attachment chips' close and cancelled the primitive's hover.
 */
const sheet = (file: string) => postcss.parse(readFileSync(join(import.meta.dir, "..", file), "utf8"))

const decls = (root: postcss.Root, selector: string, within?: string) => {
  const found = new Map<string, string>()
  root.walkRules((rule) => {
    if (!rule.selectors.some((one) => one.trim() === selector)) return
    const parent = rule.parent
    const inAt = parent && parent.type === "atrule" ? (parent as postcss.AtRule).name + " " + (parent as postcss.AtRule).params : undefined
    if (within ? !inAt?.startsWith(within) : inAt) return
    rule.walkDecls((decl) => {
      found.set(decl.prop, decl.value)
    })
  })
  return found
}

const pane = sheet("grid/pane.css")

describe("the pane note keeps an opaque ground (B1)", () => {
  test("its wash lies over --ade-overlay, as the voice note's does, so a terminal under it does not show", () => {
    const background = decls(pane, '[data-slot="pane-notice"]').get("background") ?? ""
    expect(background).toBe("linear-gradient(var(--ade-notice-bg), var(--ade-notice-bg)), var(--ade-overlay)")
  })

  test("the voice note it copies is written the same way", () => {
    expect(readFileSync(join(import.meta.dir, "..", "index.css"), "utf8")).toContain(
      "background: linear-gradient(var(--ade-notice-bg), var(--ade-notice-bg)), var(--ade-overlay);",
    )
  })
})

describe("the pane note keeps its height", () => {
  test("the 20px close takes 2px off each side of the row, so a one-line note stays about 29px", () => {
    const close = decls(pane, '[data-slot="pane-notice"] > [data-ui="icon-button"]')
    expect(close.get("margin-block")).toBe("-2px")
  })
})

describe("the attachment chips' close is the primitive's, with its hover ground (bots, chat)", () => {
  test("bots.css keeps no rule that repaints the close's ground, padding or font", () => {
    const rule = decls(sheet("bots/bots.css"), '[data-slot="bots-attachment-remove"]')
    expect([...rule.keys()]).toEqual([])
  })

  test("chat.css keeps no rule that repaints the close's ground or size", () => {
    const rule = decls(sheet("chat/chat.css"), '[data-slot="chat-attachment-remove"]')
    expect([...rule.keys()]).toEqual([])
  })

  test("bots.css keeps the focus ring of the close", () => {
    const ring = decls(sheet("bots/bots.css"), '[data-slot="bots-attachment-remove"]:focus-visible')
    expect(ring.get("box-shadow")).toBe("var(--ade-focus-ring)")
  })
})

describe("the pane note is the shared Notice, with a named close", () => {
  test("pane.tsx draws <Notice tone=\"working\" ... closeLabel=...> and no raw cross", () => {
    const source = readFileSync(join(import.meta.dir, "pane.tsx"), "utf8")
    expect(source).toContain("<Notice")
    expect(source).toContain('tone="working"')
    expect(source).toContain("closeLabel={t(\"pane.noticeDismiss\")}")
    expect(source).not.toContain("pane-notice-close")
  })
})
