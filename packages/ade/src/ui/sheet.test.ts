import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { createSignal, onMount, Show, type JSX } from "solid-js"
import { createComponent, render } from "solid-js/web"
import { Sheet, SheetTitle } from "./sheet"

/*
 * kobalte-overlay: what a sheet does, rendered, not read from its source
 * (rule 22). The hand-made Overlay trapped nothing: Tab walked out into the
 * terminals behind, and the focus did not come back to the opener.
 */
const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms))
let cleanup: (() => void) | undefined

/*
 * A browser follows every focus change with `focusin`; happy-dom sends only
 * `focus`. Kobalte's trap listens to `focusin`, so here `.focus()` sends it as
 * the browser would: nothing else about focus is simulated.
 */
const nativeFocus = HTMLElement.prototype.focus
beforeAll(() => {
  HTMLElement.prototype.focus = function (this: HTMLElement, options?: FocusOptions) {
    const before = document.activeElement
    nativeFocus.call(this, options)
    if (document.activeElement === this && before !== this) this.dispatchEvent(new FocusEvent("focusin", { bubbles: true }))
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

async function openSheet() {
  const outside = document.createElement("button")
  outside.textContent = "fuori"
  const opener = document.createElement("button")
  opener.textContent = "Decisioni"
  const root = document.createElement("div")
  document.body.append(opener, outside, root)
  opener.focus()

  const [open, setOpen] = createSignal(true)
  const closed: string[] = []
  let panel: HTMLDivElement | undefined
  cleanup = render(
    () =>
      createComponent(Show as (props: { when: boolean; children: JSX.Element }) => JSX.Element, {
        get when() {
          return open()
        },
        get children() {
          return createComponent(Sheet, {
            component: "decisions-sheet",
            onClose: () => {
              closed.push("close")
              setOpen(false)
            },
            ref: (element: HTMLDivElement) => (panel = element),
            mount: root,
            get children() {
              const title = createComponent(SheetTitle, { as: "strong", children: "Decisioni aperte" })
              const first = document.createElement("button")
              first.textContent = "Scegli"
              const last = document.createElement("button")
              last.textContent = "Invia"
              return [title, first, last]
            },
          })
        },
      }),
    root,
  )
  await tick()
  return { opener, outside, root, panel: panel!, closed, open }
}

describe("a sheet on Kobalte's Dialog", () => {
  test("the focus goes into the sheet when it opens", async () => {
    const { panel } = await openSheet()
    expect(panel).toBeDefined()
    expect(panel.contains(document.activeElement)).toBe(true)
  })

  test("the focus cannot leave it: moved outside, it comes back in", async () => {
    const { panel, outside } = await openSheet()
    outside.focus()
    await tick()
    expect(panel.contains(document.activeElement)).toBe(true)
  })

  test("Tab past the last button comes round to the first, inside", async () => {
    const { panel } = await openSheet()
    const buttons = [...panel.querySelectorAll("button")]
    buttons.at(-1)!.focus()
    // What Tab does from the last button: the trap's closing sentinel takes the focus.
    const sentinels = panel.querySelectorAll<HTMLElement>("[data-focus-trap]")
    expect(sentinels.length).toBeGreaterThan(0)
    sentinels[sentinels.length - 1]!.focus()
    await tick()
    expect(panel.contains(document.activeElement)).toBe(true)
    expect(document.activeElement).toBe(buttons[0])
  })

  test("Esc closes it", async () => {
    const { panel, closed, open } = await openSheet()
    panel.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    await tick()
    expect(closed).toEqual(["close"])
    expect(open()).toBe(false)
  })

  test("a press outside the panel closes it, one inside does not", async () => {
    const { panel, closed, root } = await openSheet()
    panel.querySelector("button")!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))
    await tick()
    expect(closed).toEqual([])
    const overlay = root.querySelector('[data-layout="overlay"]')!
    overlay.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))
    await tick()
    expect(closed).toEqual(["close"])
  })

  test("closed, the focus goes back to the button that opened it", async () => {
    const { opener, panel } = await openSheet()
    panel.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    await tick()
    expect(document.activeElement).toBe(opener)
  })

  test("a sheet that focuses its own panel on mount still keeps the focus when the opener takes it back", async () => {
    // The Decisions sheet: it focuses the panel in its own onMount, before the trap listens,
    // and the palette then gives the focus back to the terminal it came from.
    const opener = document.createElement("button")
    const root = document.createElement("div")
    document.body.append(opener, root)
    opener.focus()
    let panel: HTMLDivElement | undefined
    function Own() {
      onMount(() => panel?.focus())
      return createComponent(Sheet, {
        component: "decisions-sheet",
        onClose: () => {},
        ref: (element: HTMLDivElement) => (panel = element),
        mount: root,
        get children() {
          return createComponent(SheetTitle, { children: "Decisioni" })
        },
      })
    }
    cleanup = render(() => createComponent(Own, {}), root)
    await tick()
    opener.focus()
    await tick()
    expect(panel).toBeDefined()
    expect(panel!.contains(document.activeElement)).toBe(true)
  })

  test("opened from the palette, closed, the focus goes to where the palette sent it, not to body", async () => {
    // The palette's input opens the sheet, goes away, and gives the focus back to the terminal.
    const terminal = document.createElement("textarea")
    const palette = document.createElement("input")
    const root = document.createElement("div")
    document.body.append(terminal, palette, root)
    palette.focus()
    const [open, setOpen] = createSignal(true)
    let panel: HTMLDivElement | undefined
    cleanup = render(
      () =>
        createComponent(Show as (props: { when: boolean; children: JSX.Element }) => JSX.Element, {
          get when() {
            return open()
          },
          get children() {
            return createComponent(Sheet, {
              component: "decisions-sheet",
              onClose: () => setOpen(false),
              ref: (element: HTMLDivElement) => (panel = element),
              mount: root,
              get children() {
                return createComponent(SheetTitle, { children: "Decisioni" })
              },
            })
          },
        }),
      root,
    )
    palette.remove()
    terminal.focus()
    await tick()
    expect(panel!.contains(document.activeElement)).toBe(true)
    panel!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    await tick()
    expect(open()).toBe(false)
    expect(document.activeElement).toBe(terminal)
  })

  test("it is a modal dialog named by its title, drawn as ADE's overlay and surface", async () => {
    const { panel, root } = await openSheet()
    expect(panel.getAttribute("role")).toBe("dialog")
    expect(panel.getAttribute("aria-modal")).toBe("true")
    const title = panel.querySelector("strong")!
    expect(title.id.length).toBeGreaterThan(0)
    expect(panel.getAttribute("aria-labelledby")).toBe(title.id)
    expect(panel.getAttribute("data-layout")).toBe("surface")
    const overlay = root.querySelector('[data-layout="overlay"]')!
    expect(overlay.getAttribute("data-component")).toBe("decisions-sheet")
    expect(overlay.contains(panel)).toBe(true)
  })
})
