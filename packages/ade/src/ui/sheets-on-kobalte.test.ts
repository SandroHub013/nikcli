import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { codeOf } from "../test-support/source-text"

/*
 * kobalte-overlay: the sheets moved onto `Sheet` (`sheet.ts`), one per
 * commit. What a Sheet does is tested rendered in `sheet.test.ts`; this lint
 * keeps each moved sheet on it, named by its title, and off the hand-made
 * Overlay that trapped nothing.
 */
const SHEETS = [
  ["decisions/decisions-sheet.tsx", "decisions-sheet"],
  ["design/design-sheet.tsx", "design-sheet"],
  ["record/consent-dialog.tsx", "record-consent"],
  ["secrets/keys-section.tsx", "key-request"],
  // Review area 2, MEDIO: Tab walked out of these two into the terminals behind.
  ["remote/remote-dialog.tsx", "remote-space"],
] as const

describe("lint: the sheets are Kobalte dialogs", () => {
  test("lint: each moved sheet renders a Sheet named by a SheetTitle, and no Overlay or Surface of its own", () => {
    expect(SHEETS.length).toBeGreaterThan(0)
    for (const [file, component] of SHEETS) {
      // Without layout: prettier puts a long tag's attributes on lines of their own.
      const view = codeOf(readFileSync(join(import.meta.dir, "..", file), "utf8"))
      expect([file, view.includes(codeOf(`<Sheet component="${component}"`))]).toEqual([file, true])
      expect([file, view.includes("<SheetTitle")]).toEqual([file, true])
      expect([file, view.includes("<Overlay") || view.includes("<Surface")]).toEqual([file, false])
    }
  })

  test("lint: the palette is a Sheet too, named by its label since it shows no title", () => {
    const view = codeOf(readFileSync(join(import.meta.dir, "..", "command", "palette.tsx"), "utf8"))
    expect(view.includes(codeOf('<Sheet component="palette"'))).toBe(true)
    expect(view.includes(codeOf('label={t("palette.label")}'))).toBe(true)
    expect(view.includes("<Overlay") || view.includes("<Surface")).toBe(false)
  })

  test("lint: the Settings panel is framed by a Sheet, named by the panel's own title", () => {
    const workbench = codeOf(readFileSync(join(import.meta.dir, "..", "surface", "workbench.tsx"), "utf8"))
    const start = workbench.indexOf(codeOf('<Sheet component="voice-settings-overlay"'))
    expect(start).toBeGreaterThan(-1)
    const end = workbench.indexOf("</Sheet>", start)
    expect(end).toBeGreaterThan(start)
    const sheet = workbench.slice(start, end)
    expect(sheet.includes('labelledBy="voice-panel-title"')).toBe(true)
    expect(sheet.includes("surface={false}")).toBe(true)
    expect(sheet.includes("<VoiceSettingsPanelframed")).toBe(true)
  })

  test("lint: runCommand is guarded by the open sheets, and sheetOpen covers every sheet the workbench renders", () => {
    const workbench = readFileSync(join(import.meta.dir, "..", "surface", "workbench.tsx"), "utf8")
    expect(
      codeOf(workbench).includes(codeOf("const runCommand = guardedBySheet(sheetOpen, async (id: string) => {")),
    ).toBe(true)
    // The expression up to the next declaration: prettier puts it on the lines after the arrow.
    const open = /const sheetOpen = \(\) =>([\s\S]*?)\n\s*const /.exec(workbench)?.[1] ?? ""
    // Each sheet is rendered under its own <Show when={x()}>: every x() must be in sheetOpen.
    const shown = [
      ...workbench.matchAll(
        /<Show when=\{(\w+)\(\)\}>\s*(?:\{\/\*[^*]*\*\/\}\s*)?<(?:DecisionsSheet|DesignSheet|Sheet)\b/g,
      ),
    ].map((match) => match[1]!)
    expect(shown.length).toBe(3)
    for (const signal of shown) expect([signal, open.includes(`${signal}()`)]).toEqual([signal, true])
    // The agents' questions (M2), which are sheets too and open by themselves.
    expect(open.includes("recordAsk()")).toBe(true)
    expect(open.includes("keyRequest()")).toBe(true)
    // The remote Space dialog, a sheet with its own <Show> inside it.
    expect(open.includes("remoteOpen()")).toBe(true)
  })
})
