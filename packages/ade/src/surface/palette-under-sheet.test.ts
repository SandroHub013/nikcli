import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { createSignal, Show, type JSX } from "solid-js"
import { createComponent, render } from "solid-js/web"
import { Sheet, SheetTitle } from "../ui/sheet"
import { guardedBySheet, keepsPaletteOpen } from "./commands"
import { compileSolidJsx } from "../test-support/solid-jsx"

// The palette is `.tsx`: compiled for bun as the hub tests do.
compileSolidJsx()
const { CommandPalette } = await import("../command/palette")

/*
 * kobalte-overlay review, M1, rendered: the real palette and a sheet, and
 * Ctrl+Shift+P's command run through the same guard `runCommand` is built
 * with. Unguarded, the palette opened under the sheet's focus trap, and the
 * keys meant for it went to the sheet: in Decisioni a digit picked an option
 * and Enter sent the answer.
 */
const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms))
let cleanup: (() => void) | undefined

// As in sheet.test.ts: happy-dom sends no `focusin` on `.focus()`, and Kobalte's trap listens to it.
const nativeFocus = HTMLElement.prototype.focus
beforeAll(() => {
  HTMLElement.prototype.focus = function (this: HTMLElement, options?: FocusOptions) {
    const before = document.activeElement
    nativeFocus.call(this, options)
    if (document.activeElement === this && before !== this)
      this.dispatchEvent(new FocusEvent("focusin", { bubbles: true }))
  }
})
afterAll(() => {
  HTMLElement.prototype.focus = nativeFocus
})
afterEach(() => {
  cleanup?.()
  cleanup = undefined
  document.body.innerHTML = ""
})

function workbench(guarded: boolean) {
  const [sheetOpen, setSheetOpen] = createSignal(true)
  const [paletteOpen, setPaletteOpen] = createSignal(false)
  const sheetKeys: string[] = []
  // The part of runCommand that matters here: the palette's own command opens it.
  const run = async (id: string) => {
    if (keepsPaletteOpen(id)) setPaletteOpen(true)
  }
  const runCommand = guarded ? guardedBySheet(sheetOpen, run) : run
  let panel: HTMLDivElement | undefined
  const when = Show as (props: { when: boolean; children: JSX.Element }) => JSX.Element
  cleanup = render(
    () => [
      createComponent(when, {
        get when() {
          return sheetOpen()
        },
        get children() {
          return createComponent(Sheet, {
            component: "decisions-sheet",
            onClose: () => setSheetOpen(false),
            ref: (element: HTMLDivElement) => (panel = element),
            onKeyDown: (event: KeyboardEvent) => void sheetKeys.push(event.key),
            get children() {
              return createComponent(SheetTitle, { children: "Decisioni" })
            },
          })
        },
      }),
      createComponent(CommandPalette, {
        get open() {
          return paletteOpen()
        },
        commands: [{ id: "view.toggle", title: "Cambia vista", group: "Vista" }],
        onRun: () => {},
        onClose: () => setPaletteOpen(false),
        platform: "other",
      }),
    ],
    document.body.appendChild(document.createElement("div")),
  )
  return { runCommand, paletteOpen, setSheetOpen, sheetKeys, panel: () => panel }
}

/** A key typed where the focus is, as the keyboard would. */
const type = (key: string) =>
  document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }))

describe("the palette's shortcut with a sheet open", () => {
  test("guarded, as runCommand is: the palette does not open, and the sheet keeps the focus", async () => {
    const wb = workbench(true)
    await tick()
    expect(wb.panel()!.contains(document.activeElement)).toBe(true)
    await wb.runCommand("palette.open")
    await tick()
    expect(wb.paletteOpen()).toBe(false)
    expect(document.querySelector('[data-component="palette"]')).toBeNull()
    expect(wb.panel()!.contains(document.activeElement)).toBe(true)
  })

  /*
   * Unguarded, the palette on the old Overlay opened under the sheet's trap
   * and a digit typed for it went to the sheet. On a Sheet of its own it comes
   * on top with the keys, as a second sheet does (sheets-stacked.test.ts).
   */
  test("unguarded, the palette is a sheet too: it comes on top, and a digit typed for it stays in it", async () => {
    const wb = workbench(false)
    await tick()
    await wb.runCommand("palette.open")
    await tick()
    const palette = document.querySelector('[data-component="palette"]')
    expect(palette).not.toBeNull()
    expect(palette!.contains(document.activeElement)).toBe(true)
    type("1")
    expect(wb.sheetKeys).toEqual([])
  })

  test("with the sheet closed, the same guarded command opens the palette, with the focus in it", async () => {
    const wb = workbench(true)
    await tick()
    wb.setSheetOpen(false)
    await tick()
    await wb.runCommand("palette.open")
    await tick()
    expect(wb.paletteOpen()).toBe(true)
    const palette = document.querySelector('[data-component="palette"]')
    expect(palette).not.toBeNull()
    expect(palette!.contains(document.activeElement)).toBe(true)
  })
})

/*
 * Review area 2, MEDIO: the palette was the Overlay that trapped nothing, so
 * Tab walked out of it into the terminals behind. It is a Sheet now, like the
 * dialogs of kobalte-overlay, and gives the focus back when it goes.
 */
describe("the palette on its own", () => {
  async function openPalette() {
    const opener = document.createElement("button")
    const outside = document.createElement("button")
    document.body.append(opener, outside)
    opener.focus()
    const [open, setOpen] = createSignal(true)
    cleanup = render(
      () =>
        createComponent(CommandPalette, {
          get open() {
            return open()
          },
          commands: [{ id: "view.toggle", title: "Cambia vista", group: "Vista" }],
          onRun: () => {},
          onClose: () => setOpen(false),
          platform: "other",
        }),
      document.body.appendChild(document.createElement("div")),
    )
    await tick()
    const palette = document.querySelector<HTMLElement>('[data-component="palette"]')!
    return { opener, outside, palette, setOpen }
  }

  test("the focus is in its field, and moved outside it comes back in", async () => {
    const { outside, palette } = await openPalette()
    expect(document.activeElement?.getAttribute("data-slot")).toBe("input")
    outside.focus()
    await tick()
    expect(palette.contains(document.activeElement)).toBe(true)
  })

  test("it is a modal dialog named for what it is", async () => {
    const { palette } = await openPalette()
    const dialog = palette.querySelector('[role="dialog"]')!
    expect(dialog.getAttribute("aria-modal")).toBe("true")
    expect(dialog.getAttribute("aria-label")).toBeTruthy()
  })

  test("closed, the focus goes back to what had it", async () => {
    const { opener, setOpen } = await openPalette()
    setOpen(false)
    await tick()
    expect(document.querySelector('[data-component="palette"]')).toBeNull()
    expect(document.activeElement).toBe(opener)
  })
})
