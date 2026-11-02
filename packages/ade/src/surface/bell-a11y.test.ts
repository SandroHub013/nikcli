import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import postcss from "postcss"
import { translate } from "../i18n"

/**
 * The bell's panel for assistive technology (UX-20), and the close controls that were drawn as a glyph (DS-21).
 *
 * The workbench is too large to mount, so these read the source: what is pinned is the markup's contract — a role
 * that is true of what the panel holds, a name for each discard, an alert for a failure — not a rendering.
 */
const source = readFileSync(new URL("./workbench.tsx", import.meta.url), "utf8").replace(/\r\n/g, "\n")

/** The JSX of the notifications panel: from the bell's trigger to the end of the notices list. */
const panel = source.slice(source.indexOf('data-action="notifications"'), source.indexOf('data-slot="ade-notice-dismiss"') + 400)

describe("the bell", () => {
  test("its panel is a labelled region with a list, because it holds text, a bar and buttons, not menu items", () => {
    expect(panel).toContain('role="region"')
    expect(panel).toContain('role="list"')
    expect(panel).toContain('role="listitem"')
    expect(panel).not.toContain('role="menu"')
  })

  test("the bell no longer announces a menu it does not open", () => {
    const trigger = panel.slice(0, panel.indexOf("onClick"))
    expect(trigger).not.toContain('aria-haspopup="menu"')
    // It still says whether the panel is open.
    expect(trigger).toContain("aria-expanded={noticesOpen()}")
  })

  test("a row in the panel is not an alert: opening the bell would announce every kept failure again", () => {
    expect(panel).not.toContain('role="alert"')
    expect(panel).not.toContain('"alert"')
  })

  test("the failure is announced once, where it appears: the strip, which is an alert only for an error", () => {
    // `report()` fills the strip and the list together; the strip is what is new, the list is the history.
    expect(source).toContain("const [noticeKind, setNoticeKind] = createSignal<NoticeKind>")
    const report = source.slice(source.indexOf("const report = "), source.indexOf("const restoreSessions"))
    expect(report).toContain("setNoticeKind(kind)")
    const at = source.indexOf('<div data-slot="ade-notice"')
    expect(at).toBeGreaterThan(-1)
    expect(source.slice(at, at + 160)).toContain('role={noticeKind() === "error" ? "alert" : "status"}')
  })

  test("the tooltip of a dismiss is the short word, not the whole notice again", () => {
    // `IconButton` copies its label to `title`; a long notice would show up as a tooltip as long as the row itself.
    expect(panel).toContain('title={t("bar.dismissNotice")}')
  })

  test("each dismiss says which notice it discards", () => {
    expect(panel).toContain('label={t("bell.dismiss.named", notice.text)}')
    expect(translate("it", "bell.dismiss.named", "Aggiornamento pronto")).toBe("Togli: Aggiornamento pronto")
    expect(translate("en", "bell.dismiss.named", "Update ready")).toBe("Dismiss: Update ready")
  })
})

describe("the bell's ground in the glass theme", () => {
  test("a panel that is no longer role=menu still takes the overlay ground", () => {
    // The glass rule is keyed on roles, and the bell's panel stopped being a `menu` (it is a region): without its slot
    // in the list the panel is a 6% lift again, with terminal lines running through the notices.
    const css = readFileSync(new URL("../index.css", import.meta.url), "utf8").replace(/\r\n/g, "\n")
    const grounded: string[] = []
    postcss.parse(css).walkRules((rule) => {
      const sets = rule.nodes.some((node) => node.type === "decl" && node.prop === "background" && node.value === "var(--ade-overlay)")
      if (sets) grounded.push(...rule.selectors.map((selector) => selector.replace(/\s+/g, " ")))
    })
    expect(grounded).toContain('[data-component="ade-shell"][data-theme="glass"] [data-slot="ade-menu"]')
    // The role-keyed shape stays.
    expect(grounded).toContain('[data-component="ade-shell"][data-theme="glass"] [role="menu"]')
  })
})

describe("the workbench's notices", () => {
  test("the voice notice is a Notice and an alert, with no inline style of its own (DS-16)", () => {
    const at = source.indexOf('data-slot="ade-voice-notice"')
    expect(at).toBeGreaterThan(-1)
    const block = source.slice(source.lastIndexOf("<NoticeBanner", at), source.indexOf("</NoticeBanner>", at))
    expect(block).toContain('role="alert"')
    expect(block).toContain('tone="working"')
    expect(block).not.toContain("style={{")
  })

  test("no close control is drawn as a ✕ or × glyph in a text node (DS-21)", () => {
    // Between a tag and the next one, so a comment or a string that mentions the glyph is not read as a control.
    const glyphs = [...source.matchAll(/>\s*([✕×])\s*</g)].map((match) => source.slice(0, match.index).split("\n").length)
    expect(glyphs).toEqual([])
  })
})
