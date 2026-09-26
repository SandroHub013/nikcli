import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { createSignal, onMount, Show, type JSX } from "solid-js"
import { createComponent, render } from "solid-js/web"
import { readFileSync } from "node:fs"
import { join } from "node:path"
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

  test("Shift+Tab right after it opens, on the panel itself, goes to the last control (Verifiche, kobalte-overlay-scatti)", async () => {
    const { panel } = await openSheet()
    expect(document.activeElement).toBe(panel)
    const event = new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true })
    panel.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    const buttons = [...panel.querySelectorAll("button")]
    expect(document.activeElement).toBe(buttons.at(-1)!)
    expect(document.activeElement?.textContent).toBe("Invia")
  })

  test("a plain Tab on the panel, and Shift+Tab from a control, are left to the browser and the trap", async () => {
    const { panel } = await openSheet()
    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })
    panel.dispatchEvent(tab)
    expect(tab.defaultPrevented).toBe(false)
    const first = panel.querySelector("button")!
    first.focus()
    const back = new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true })
    first.dispatchEvent(back)
    expect(back.defaultPrevented).toBe(false)
  })

  test("lint: the bare frame is rounded like a surface, so the focus ring follows the panel's corners", () => {
    const css = readFileSync(join(import.meta.dir, "layout.css"), "utf8")
    const start = css.indexOf(':where([data-layout="frame"]) {')
    expect(start).toBeGreaterThan(-1)
    const rule = css.slice(start, css.indexOf("}", start))
    expect(rule.includes("border-radius: var(--ade-radius-xl);")).toBe(true)
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

  test("around a panel with its own box and title (Settings): a bare frame, named by that title", async () => {
    const root = document.createElement("div")
    document.body.append(root)
    let panel: HTMLDivElement | undefined
    cleanup = render(
      () =>
        createComponent(Sheet, {
          component: "voice-settings-overlay",
          onClose: () => {},
          surface: false,
          labelledBy: "voice-panel-title",
          ref: (element: HTMLDivElement) => (panel = element),
          mount: root,
          get children() {
            const own = document.createElement("div")
            own.innerHTML = '<h2 id="voice-panel-title">Impostazioni</h2><button>Fatto</button>'
            return own
          },
        }),
      root,
    )
    await tick()
    expect(panel!.getAttribute("role")).toBe("dialog")
    expect(panel!.getAttribute("aria-modal")).toBe("true")
    expect(panel!.getAttribute("aria-labelledby")).toBe("voice-panel-title")
    expect(panel!.getAttribute("data-layout")).toBe("frame")
    expect(panel!.contains(document.activeElement)).toBe(true)
  })

  test("closed by something that gives the focus elsewhere at once, the focus stays there (review, BASSO 1)", async () => {
    // «Pannello completo»: the sheet closes and the pane it opens takes the focus in the same pass.
    const opener = document.createElement("button")
    const pane = document.createElement("textarea")
    const root = document.createElement("div")
    document.body.append(opener, pane, root)
    opener.focus()
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
              component: "design-sheet",
              onClose: () => setOpen(false),
              ref: (element: HTMLDivElement) => (panel = element),
              mount: root,
              get children() {
                return createComponent(SheetTitle, { children: "Design" })
              },
            })
          },
        }),
      root,
    )
    await tick()
    expect(panel!.contains(document.activeElement)).toBe(true)
    setOpen(false)
    pane.focus()
    await tick()
    expect(document.activeElement).toBe(pane)
  })

  test("a sheet opened over another gives the focus back to it, and the lower one to its opener (review, BASSO 2)", async () => {
    const opener = document.createElement("button")
    const root = document.createElement("div")
    document.body.append(opener, root)
    opener.focus()
    const [upper, setUpper] = createSignal(false)
    const [lower, setLower] = createSignal(true)
    let lowerPanel: HTMLDivElement | undefined
    let upperPanel: HTMLDivElement | undefined
    const when = Show as (props: { when: boolean; children: JSX.Element }) => JSX.Element
    cleanup = render(
      () => [
        createComponent(when, {
          get when() {
            return lower()
          },
          get children() {
            return createComponent(Sheet, {
              component: "decisions-sheet",
              onClose: () => setLower(false),
              ref: (element: HTMLDivElement) => (lowerPanel = element),
              mount: root,
              get children() {
                return createComponent(SheetTitle, { children: "Decisioni" })
              },
            })
          },
        }),
        createComponent(when, {
          get when() {
            return upper()
          },
          get children() {
            return createComponent(Sheet, {
              component: "record-consent",
              role: "alertdialog",
              onClose: () => setUpper(false),
              ref: (element: HTMLDivElement) => (upperPanel = element),
              mount: root,
              get children() {
                return createComponent(SheetTitle, { children: "Registrare?" })
              },
            })
          },
        }),
      ],
      root,
    )
    await tick()
    expect(lowerPanel!.contains(document.activeElement)).toBe(true)
    // An agent asks while the sheet is open: the question comes on top and has the keys.
    setUpper(true)
    await tick()
    expect(upperPanel!.getAttribute("role")).toBe("alertdialog")
    expect(upperPanel!.contains(document.activeElement)).toBe(true)
    upperPanel!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    await tick()
    expect([upper(), lower()]).toEqual([false, true])
    expect(lowerPanel!.contains(document.activeElement)).toBe(true)
    lowerPanel!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    await tick()
    expect(lower()).toBe(false)
    expect(document.activeElement).toBe(opener)
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
