import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/*
 * The expanded pane's button still said «Ingrandisci», while it puts the grid
 * back (Verifiche, mouse sessions, point 5). Read from the sources: a .tsx
 * rendered in bun test is compiled as React (solid-tsx-bun-test-trap).
 */
const dir = import.meta.dir
const actions = readFileSync(join(dir, "pane-actions.tsx"), "utf8")
const pane = readFileSync(join(dir, "pane.tsx"), "utf8")
const renderer = readFileSync(join(dir, "..", "surface", "pane-renderer.tsx"), "utf8")

describe("the expanded pane's button says it reduces", () => {
  test("the pane actions and the pane's own button pick the label from `expanded`", () => {
    // The actions name the pane too (UX-21, below): the verb still comes from `expanded`.
    expect(actions).toContain('props.expanded ? "pane.restore.named" : "pane.expand.named"')
    expect(actions).toContain('props.expanded ? t("pane.restore") : t("pane.expand")')
    expect(pane).toMatch(/<PaneActions onExpand=\{\(\) => props\.onExpand\?\.\(\)\}[^\n]*expanded=\{props\.expanded\}/)
  })

  /*
   * Review of ade/testi-resto, UX-21: under 400px the header's only button is the «more» one, and it still said
   * «Ingrandisci» with no pane's name, as the full-width button no longer does.
   */
  test("the narrow header's single button names its pane like the full-width one", () => {
    const more = pane.slice(pane.indexOf('class="act more"'), pane.indexOf("</button>", pane.indexOf('class="act more"')))
    expect(pane.includes("const expandLabel = ")).toBe(true)
    expect(pane.includes('props.expanded ? "pane.restore.named" : "pane.expand.named", props.title')).toBe(true)
    expect(more.includes("aria-label={expandLabel()}")).toBe(true)
    expect(more.includes("title={expandLabel()}")).toBe(true)
    expect(more.includes("data-tip={expandLabel()}")).toBe(true)
    expect(more.includes('t("pane.expand")')).toBe(false)
  })

  /*
   * UX-21. The narrow header swaps the two buttons for one drawn as «⋯», which means «more actions» everywhere else
   * in ADE and here only expanded the pane; and the close button was named «Chiudi» with no word of what it closes.
   */
  test("the narrow header's single button is drawn as an expand, not as «more actions»", () => {
    const more = pane.slice(pane.indexOf('class="act more"'), pane.indexOf("</button>", pane.indexOf('class="act more"')))
    expect(more).not.toContain("<circle")
    expect(more).toContain("M3 6V3h3M10 3h3v3M13 10v3h-3M6 13H3v-3")
  })

  test("the close button names the pane it closes", async () => {
    expect(actions).toContain('t("pane.close.named", props.title)')
    expect(pane).toMatch(/<PaneActions [^\n]*title=\{props\.title\}/)
    const { translate } = await import("../i18n")
    expect(translate("it", "pane.close.named", "Claude 2")).toBe("Chiudi Claude 2")
    expect(translate("en", "pane.close.named", "Claude 2")).toBe("Close Claude 2")
  })

  test("Ingrandisci, Riduci and Sospendi name the pane too, as Chiudi does (UX-21)", async () => {
    const { translate } = await import("../i18n")
    expect(translate("it", "pane.expand.named", "Claude 2")).toBe("Ingrandisci Claude 2")
    expect(translate("it", "pane.restore.named", "Claude 2")).toBe("Riduci Claude 2")
    expect(translate("it", "pane.suspend.named", "Claude 2")).toBe("Sospendi Claude 2")
    expect(translate("en", "pane.expand.named", "Claude 2")).toBe("Maximize Claude 2")
    expect(translate("en", "pane.restore.named", "Claude 2")).toBe("Restore Claude 2")
    expect(translate("en", "pane.suspend.named", "Claude 2")).toBe("Suspend Claude 2")
  })

  test("the expand button's label and tooltip, and the Sospendi button's label, carry the title when there is one", () => {
    // `.includes` and booleans: a failed `toContain` would print the whole file.
    expect(actions.includes("const expandLabel = ")).toBe(true)
    expect(/aria-label=\{expandLabel\(\)\}\s+title=\{expandLabel\(\)\}/.test(actions)).toBe(true)
    expect(pane.includes('props.title ? t("pane.suspend.named", props.title) : t("pane.suspend")')).toBe(true)
  })

  test("a session pane is told when it fills the grid", () => {
    expect(renderer).toContain("expanded={wb().expandedId === current().id}")
  })

  test("«Riduci», «Restore»", async () => {
    const it = (await import("../i18n/it")).it as Record<string, unknown>
    const en = (await import("../i18n/en")).en as Record<string, unknown>
    expect(it["pane.restore"]).toBe("Riduci")
    expect(en["pane.restore"]).toBe("Restore")
  })
})
