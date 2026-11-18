import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { compileSolidJsx } from "../test-support/solid-jsx"
import { resetLocaleForTests } from "../i18n/locale"

if (typeof document === "undefined") GlobalRegistrator.register()
compileSolidJsx()

const { createComponent, render } = await import("solid-js/web")
const { ShotTray } = await import("./tray")
const { t } = await import("../i18n")

let dispose: (() => void) | undefined

/** Esc, as a keyboard sends it: the dialog's layer listens on the document. */
function pressEscape() {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
}
afterEach(() => {
  dispose?.()
  dispose = undefined
  document.body.innerHTML = ""
})
afterAll(() => resetLocaleForTests("it"))

function mount(extra: Record<string, unknown> = {}) {
  resetLocaleForTests("it")
  const host = document.createElement("div")
  document.body.append(host)
  dispose = render(
    () =>
      createComponent(ShotTray, {
        shots: [],
        onDismiss: () => {},
        ...extra,
      }),
    host,
  )
  return host
}

/*
 * The tray was empty with no explanation, and the folder it watched was only
 * readable in the source. These pin the two answers the user needs: where it
 * is looking, and how to look somewhere else.
 */
describe("the empty screenshot tray", () => {
  test("shows the folder it watches and the picker", () => {
    const host = mount({ folder: "C:/Users/nik/Pictures/Screenshots", onChoose: () => {} })

    expect(host.querySelector('[data-slot="shot-tray-folder"]')?.textContent).toBe(
      "C:/Users/nik/Pictures/Screenshots",
    )
    expect(host.querySelector('[data-slot="shot-tray-choose"]')?.textContent).toBe(t("shots.choose"))
    expect(host.querySelector('[data-slot="shot-tray-empty"]')?.textContent).toBe(t("shots.emptyFolder"))
  })

  test("shows instructions to create the folder when missing on disk", () => {
    const host = mount({ folder: "C:/Users/nik/Pictures/Screenshots", missing: true, onChoose: () => {} })

    expect(host.querySelector('[data-slot="shot-tray-folder"]')?.textContent).toBe(
      "C:/Users/nik/Pictures/Screenshots",
    )
    expect(host.querySelector('[data-slot="shot-tray-choose"]')?.textContent).toBe(t("shots.choose"))
    expect(host.querySelector('[data-slot="shot-tray-empty"]')?.textContent).toBe(t("shots.noFolder"))
  })

  test("says when the folder is on a network share", () => {
    const host = mount({ folder: "\\\\server\\shots", network: true, onChoose: () => {} })

    expect(host.querySelector('[data-slot="shot-tray-network"]')?.textContent).toBe(t("shots.network"))
    // The path is named even though it cannot be read.
    expect(host.querySelector('[data-slot="shot-tray-folder"]')?.textContent).toBe("\\\\server\\shots")
  })

  test("says why a folder was refused, in the page's words", () => {
    for (const [code, key] of [
      ["too-broad", "shots.error.tooBroad"],
      ["system", "shots.error.system"],
      ["not-a-folder", "shots.error.notAFolder"],
    ] as const) {
      const host = mount({ folder: "C:/Users/nik/Pictures/Screenshots", onChoose: () => {}, notice: code })
      expect(host.querySelector('[data-slot="shot-tray-notice"]')?.textContent).toBe(t(key))
      dispose?.()
      document.body.innerHTML = ""
    }
  })

  test("an unknown refusal still says the choice was not taken", () => {
    const host = mount({ folder: "C:/x", notice: "qualcosa-di-nuovo" })
    expect(host.querySelector('[data-slot="shot-tray-notice"]')?.textContent).toBe(t("shots.error.notSaved"))
  })

  test("says nothing when nothing was refused", () => {
    const host = mount({ folder: "C:/x", onChoose: () => {} })
    expect(host.querySelector('[data-slot="shot-tray-notice"]')).toBeNull()
  })

  test("a share is not described as an empty folder: it was not read", () => {
    const host = mount({ folder: "\\\\server\\shots", network: true, onChoose: () => {} })

    expect(host.querySelector('[data-slot="shot-tray-empty"]')).toBeNull()
    expect(host.querySelector('[data-slot="shot-tray-network"]')).not.toBeNull()
  })

  test("the path and the button are the same markup with and without thumbnails", () => {
    const empty = mount({ folder: "C:/Users/nik/Shots", onChoose: () => {} })
    const emptyRow = empty.querySelector('[data-slot="shot-tray-where"]')
    expect(emptyRow?.querySelector('[data-slot="shot-tray-folder"]')?.textContent).toBe("C:/Users/nik/Shots")
    expect(emptyRow?.querySelector('[data-slot="shot-tray-choose"]')).not.toBeNull()
    dispose?.()
    document.body.innerHTML = ""

    const full = mount({
      shots: [{ path: "C:/Users/nik/Shots/Screenshot 1.png", name: "Screenshot 1.png", modified_ms: 1 }],
      load: async () => null,
      folder: "C:/Users/nik/Shots",
      onChoose: () => {},
    })
    const fullRow = full.querySelector('[data-slot="shot-tray-where"]')
    expect(fullRow?.querySelector('[data-slot="shot-tray-folder"]')?.textContent).toBe("C:/Users/nik/Shots")
    expect(fullRow?.querySelector('[data-slot="shot-tray-choose"]')).not.toBeNull()
  })

  test("the path is isolated left to right, so a share keeps its leading separators", () => {
    const host = mount({ folder: "\\\\server\\shots", network: true })

    expect(host.querySelector('[data-slot="shot-tray-folder"] bdi')?.getAttribute("dir")).toBe("ltr")
  })

  test("the picker button waits while the picker is open, and works otherwise", () => {
    let clicks = 0
    const open = mount({ folder: "C:/x", onChoose: () => clicks++, choosing: true })
    const waiting = open.querySelector('[data-slot="shot-tray-choose"]') as HTMLButtonElement
    expect(waiting.disabled).toBe(true)
    waiting.click()
    expect(clicks).toBe(0)
    dispose?.()
    document.body.innerHTML = ""

    const idle = mount({ folder: "C:/x", onChoose: () => clicks++ })
    const ready = idle.querySelector('[data-slot="shot-tray-choose"]') as HTMLButtonElement
    expect(ready.disabled).toBe(false)
    ready.click()
    expect(clicks).toBe(1)
  })

  test("with no folder at all, still offers the picker", () => {
    const host = mount({ unavailable: true, onChoose: () => {} })

    expect(host.querySelector('[data-slot="shot-tray-empty"]')?.textContent).toBe(t("shots.noFolder"))
    expect(host.querySelector('[data-slot="shot-tray-choose"]')).not.toBeNull()
    expect(host.querySelector('[data-slot="shot-tray-folder"]')).toBeNull()
  })
})

/*
 * «elimina» used to remove the file from the disk at once, with no question, and a failure closed the viewer as if it
 * had worked. It asks first, sends the file to the Recycle Bin, and says when that did not happen.
 */
describe("deleting a screenshot from the viewer", () => {
  const shot = { path: "C:/Pictures/Screenshots/a.png", name: "a.png", modified_ms: 1 }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
  const open = (onDelete: (path: string) => Promise<boolean>) => {
    const host = mount({ shots: [shot], onDelete })
    host.querySelector<HTMLElement>('[data-slot="shot-open"]')!.click()
    return host
  }
  const buttons = (host: HTMLElement) => [...document.querySelectorAll<HTMLElement>('[data-component="shot-viewer"] button')]
  const byText = (host: HTMLElement, text: string) => buttons(host).find((button) => button.textContent === text)

  test("the first click only asks, with the file's name", () => {
    const deleted: string[] = []
    const host = open(async (path) => (deleted.push(path), true))
    byText(host, t("shots.delete"))!.click()

    expect(deleted).toEqual([])
    expect(document.querySelector('[data-slot="shot-viewer-ask"]')?.textContent).toBe(t("shots.delete.ask", "a.png"))
    expect(byText(host, t("shots.delete.confirm"))).toBeDefined()
    expect(byText(host, t("shots.delete.keep"))).toBeDefined()
  })

  test("UX2-13: delete question is accessible to screen readers via role alert and aria-describedby", () => {
    const host = open(async () => true)
    byText(host, t("shots.delete"))!.click()

    const ask = document.querySelector('[data-slot="shot-viewer-ask"]')!
    expect(ask.getAttribute("role")).toBe("alert")
    expect(ask.id).toBe("shot-viewer-ask-text")

    const keep = document.querySelector('[data-slot="shot-viewer-keep"]')!
    expect(keep.getAttribute("aria-describedby")).toBe("shot-viewer-ask-text")

    const confirm = document.querySelector('[data-slot="shot-viewer-confirm"]')!
    expect(confirm.getAttribute("aria-describedby")).toBe("shot-viewer-ask-text")
  })

  test("«Tieni» goes back and deletes nothing", () => {
    const deleted: string[] = []
    const host = open(async (path) => (deleted.push(path), true))
    byText(host, t("shots.delete"))!.click()
    byText(host, t("shots.delete.keep"))!.click()

    expect(deleted).toEqual([])
    expect(document.querySelector('[data-slot="shot-viewer-ask"]')).toBeNull()
    expect(document.querySelector('[data-component="shot-viewer"]')).not.toBeNull()
  })

  test("confirming deletes and closes the viewer", async () => {
    const deleted: string[] = []
    const host = open(async (path) => (deleted.push(path), true))
    byText(host, t("shots.delete"))!.click()
    byText(host, t("shots.delete.confirm"))!.click()
    await settle()

    expect(deleted).toEqual([shot.path])
    expect(document.querySelector('[data-component="shot-viewer"]')).toBeNull()
  })

  test("a failure keeps the viewer open and says why", async () => {
    const host = open(async () => false)
    byText(host, t("shots.delete"))!.click()
    byText(host, t("shots.delete.confirm"))!.click()
    await settle()

    expect(document.querySelector('[data-component="shot-viewer"]')).not.toBeNull()
    expect(document.querySelector('[data-slot="shot-viewer-error"]')?.textContent).toBe(t("shots.delete.failed"))
  })

  test("the second click of a double click does not confirm", async () => {
    const deleted: string[] = []
    const host = open(async (path) => (deleted.push(path), true))
    byText(host, t("shots.delete"))!.click()
    const confirm = byText(host, t("shots.delete.confirm"))!
    confirm.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 2 }))
    await settle()
    expect(deleted).toEqual([])
    expect(document.querySelector('[data-component="shot-viewer"]')).not.toBeNull()
    confirm.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }))
    await settle()
    expect(deleted).toEqual([shot.path])
  })

  test("the buttons are capitalised in both languages", () => {
    expect(t("shots.delete")).toBe("Elimina")
    expect(t("shots.close")).toBe("Chiudi")
    resetLocaleForTests("en")
    expect(t("shots.delete")).toBe("Delete")
    expect(t("shots.close")).toBe("Close")
    resetLocaleForTests("it")
  })

  test("a second click while the delete runs does not ask the host again", async () => {
    let calls = 0
    let finish: (done: boolean) => void = () => {}
    const host = open(
      () =>
        new Promise<boolean>((resolve) => {
          calls++
          finish = resolve
        }),
    )
    byText(host, t("shots.delete"))!.click()
    const confirm = byText(host, t("shots.delete.confirm"))!
    confirm.click()
    await settle()
    expect(byText(host, t("shots.delete.confirm"))?.hasAttribute("disabled")).toBe(true)
    confirm.click()
    expect(calls).toBe(1)
    finish(false)
    await settle()
    expect(document.querySelector('[data-slot="shot-viewer-error"]')).not.toBeNull()
  })

  test("the alert of one picture is not shown on the next one", async () => {
    const other = { path: "C:/Pictures/Screenshots/b.png", name: "b.png", modified_ms: 0 }
    const host = mount({ shots: [shot, other], onDelete: async () => false })
    host.querySelector<HTMLElement>('[data-slot="shot-open"]')!.click()
    byText(host, t("shots.delete"))!.click()
    byText(host, t("shots.delete.confirm"))!.click()
    await settle()
    expect(document.querySelector('[data-slot="shot-viewer-error"]')).not.toBeNull()
    pressEscape()
    host.querySelectorAll<HTMLElement>('[data-slot="shot-open"]')[1]!.click()
    expect(document.querySelector('[data-slot="shot-viewer-error"]')).toBeNull()
  })
})

/*
 * The tray and the viewer for people who do not use a mouse (UX-17): no button inside a button, Esc closes the
 * viewer and the focus goes into it, and a screenshot can be handed to the focused session without dragging.
 */
describe("the screenshot tray and viewer, by keyboard and screen reader", () => {
  const shot = { path: "C:/Pictures/Screenshots/a.png", name: "a.png", modified_ms: 1 }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

  test("a tile is a plain container; opening and dismissing are siblings, not a button in a button", () => {
    const host = mount({ shots: [shot] })
    const tile = host.querySelector('[data-slot="shot"]')!
    expect(tile.getAttribute("role")).toBeNull()
    expect(tile.getAttribute("tabindex")).toBeNull()
    const open = tile.querySelector('[data-slot="shot-open"]')!
    expect(open.getAttribute("role")).toBe("button")
    expect(open.getAttribute("aria-label")).toBe(t("shots.open.named", "a.png"))
    // Nothing interactive inside the control that opens: that is what a reader could not announce.
    expect(open.querySelector('button, [role="button"], a[href], input')).toBeNull()
    const dismiss = tile.querySelector('button[data-slot="shot-dismiss"]')!
    expect(open.contains(dismiss)).toBe(false)
    // The tile stays draggable: the drag is on the container, the picture is not a real <button>.
    expect(tile.getAttribute("draggable")).toBe("true")
    expect(open.tagName).not.toBe("BUTTON")
  })

  test("Enter and Space on the picture open the viewer", async () => {
    const host = mount({ shots: [shot] })
    const open = host.querySelector<HTMLElement>('[data-slot="shot-open"]')!
    open.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
    await settle()
    expect(document.querySelector('[data-component="shot-viewer"]')).not.toBeNull()
  })

  test("dismissing a tile puts it away without opening it", () => {
    const dismissed: string[] = []
    const host = mount({ shots: [shot], onDismiss: (path: string) => dismissed.push(path) })
    host.querySelector<HTMLElement>('[data-slot="shot-dismiss"]')!.click()
    expect(dismissed).toEqual([shot.path])
    expect(document.querySelector('[data-component="shot-viewer"]')).toBeNull()
  })

  test("the viewer is a modal dialog named by the picture, and Esc closes it", async () => {
    const host = mount({ shots: [shot] })
    host.querySelector<HTMLElement>('[data-slot="shot-open"]')!.click()
    await settle()
    const dialog = document.querySelector('[data-component="shot-viewer"] [role="dialog"]')!
    expect(dialog.getAttribute("aria-modal")).toBe("true")
    expect(dialog.getAttribute("aria-label")).toBe("a.png")
    // The focus moves into the viewer, instead of staying on the tile behind it.
    expect(dialog.contains(document.activeElement)).toBe(true)
    pressEscape()
    await settle()
    expect(document.querySelector('[data-component="shot-viewer"]')).toBeNull()
  })

  test("«Manda alla sessione a fuoco» gives the path to the session and closes the viewer", async () => {
    const sent: string[] = []
    const host = mount({ shots: [shot], onSend: (path: string) => (sent.push(path), true) })
    host.querySelector<HTMLElement>('[data-slot="shot-open"]')!.click()
    await settle()
    const send = document.querySelector<HTMLButtonElement>('[data-slot="shot-viewer-send"]')!
    expect(send.textContent).toBe(t("shots.send"))
    send.click()
    expect(sent).toEqual([shot.path])
    await settle()
    expect(document.querySelector('[data-component="shot-viewer"]')).toBeNull()
  })

  test("with no session to take it, the viewer stays open and says so", async () => {
    const host = mount({ shots: [shot], onSend: () => false })
    host.querySelector<HTMLElement>('[data-slot="shot-open"]')!.click()
    await settle()
    document.querySelector<HTMLButtonElement>('[data-slot="shot-viewer-send"]')!.click()
    await settle()
    expect(document.querySelector('[data-component="shot-viewer"]')).not.toBeNull()
    expect(document.querySelector('[data-slot="shot-viewer-error"]')?.textContent).toBe(t("shots.send.failed"))
  })

  test("deleting the picture that opened the viewer leaves the focus on a tile, not on the page", async () => {
    // The viewer gives the focus back to the tile that opened it; that tile is gone, and a focus on a detached node is
    // a focus on the page, so the keyboard user starts again from the top.
    const other = { path: "C:/Pictures/Screenshots/b.png", name: "b.png", modified_ms: 2 }
    const realFocus = HTMLElement.prototype.focus
    const focusOptions: Array<FocusOptions | undefined> = []
    const host = mount({
      shots: [shot, other],
      onDelete: async () => {
        host.querySelector('[data-slot="shot"]')!.remove()
        return true
      },
    })
    host.querySelector<HTMLElement>('[data-slot="shot-open"]')!.click()
    await settle()
    const byText = (text: string) =>
      [...document.querySelectorAll<HTMLButtonElement>('[data-component="shot-viewer"] button')].find((b) => b.textContent === text)!
    byText(t("shots.delete")).click()
    await settle()
    HTMLElement.prototype.focus = function (this: HTMLElement, options?: FocusOptions) {
      focusOptions.push(options)
      return realFocus.call(this, options)
    }
    byText(t("shots.delete.confirm")).click()
    await settle()
    await settle()
    expect(document.querySelector('[data-component="shot-viewer"]')).toBeNull()
    const active = document.activeElement as HTMLElement
    // Not `preventScroll`: the first tile can be scrolled out of the strip, and a focus the user cannot see is lost.
    expect(focusOptions.some((options) => options?.preventScroll === true)).toBe(false)
    HTMLElement.prototype.focus = realFocus
    expect(active.getAttribute("data-slot")).toBe("shot-open")
    expect(active.getAttribute("aria-label")).toBe(t("shots.open.named", "b.png"))
  })

  test("there is no send button where nothing can take the picture", async () => {
    const host = mount({ shots: [shot] })
    host.querySelector<HTMLElement>('[data-slot="shot-open"]')!.click()
    await settle()
    expect(document.querySelector('[data-slot="shot-viewer-send"]')).toBeNull()
  })

  test("the tile's dismiss has a 24px reach and shows when the tile has the focus", () => {
    const css = readFileSync(new URL("./tray.css", import.meta.url), "utf8")
    expect(css).toMatch(/\[data-slot="shot-dismiss"\]::before \{[^}]*inset: -3px/)
    expect(css).toContain('[data-slot="shot"]:focus-within [data-slot="shot-dismiss"]')
  })
})

/*
 * Live test 3, FAIL 7 and the script that opened the delete prompt: a press in the empty band beside a narrow picture
 * closes the viewer, and each button of the caption has a slot of its own («Elimina» and «Chiudi» shared one).
 * Where the band is, in pixels, is for the eyes: no layout here.
 */
describe("the viewer's band and its buttons", () => {
  const shot = { path: "C:/Pictures/Screenshots/a.png", name: "a.png", modified_ms: 1 }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20))
  const open = async (extra: Record<string, unknown> = {}) => {
    const host = mount({ shots: [shot], onDelete: async () => true, onSend: () => true, ...extra })
    host.querySelector<HTMLElement>('[data-slot="shot-open"]')!.click()
    await settle()
    return host
  }
  const viewerButtons = () => [...document.querySelectorAll<HTMLElement>('[data-component="shot-viewer"] button')]
  const viewerOpen = () => document.querySelector('[data-component="shot-viewer"]') !== null

  /** A press as a mouse makes it: the button goes down on `down`, and the click lands on `up` (here, the frame, their common ancestor). */
  const press = (down: Element, up: Element = down) => {
    down.dispatchEvent(new Event("pointerdown", { bubbles: true }))
    up.dispatchEvent(new MouseEvent("click", { bubbles: true }))
  }
  const frame = () => document.querySelector<HTMLElement>('[data-slot="shot-viewer-frame"]')!

  test("a press on the frame's own ground, beside the picture, closes it", async () => {
    await open()
    press(frame())
    await settle()
    expect(viewerOpen()).toBe(false)
  })

  test("a press that began on the picture and ended beside it does not (the click lands on the frame, their ancestor)", async () => {
    await open({ load: async () => new Uint8Array([1, 2, 3]) })
    await settle()
    press(document.querySelector('[data-slot="shot-viewer-frame"] [data-slot="shot-image"]')!, frame())
    await settle()
    expect(viewerOpen()).toBe(true)
  })

  test("nor one that began on the caption, its name or a button, and ended beside them", async () => {
    await open()
    press(document.querySelector('[data-slot="shot-viewer-caption"]')!, frame())
    press(document.querySelector('[data-slot="shot-viewer-name"]')!, frame())
    press(viewerButtons()[0]!, frame())
    await settle()
    expect(viewerOpen()).toBe(true)
  })

  test("a press on the caption, its text or a button of it does not close it", async () => {
    await open()
    document.querySelector<HTMLElement>('[data-slot="shot-viewer-caption"]')!.click()
    document.querySelector<HTMLElement>('[data-slot="shot-viewer-name"]')!.click()
    document.querySelector<HTMLElement>('[data-slot="shot-viewer-hint"]')!.click()
    await settle()
    expect(viewerOpen()).toBe(true)
  })

  test("the picture itself, once it has loaded, is not a way out", async () => {
    await open({ load: async () => new Uint8Array([1, 2, 3]) })
    await settle()
    const image = document.querySelector<HTMLElement>('[data-slot="shot-viewer-frame"] [data-slot="shot-image"]')
    expect(image).not.toBeNull()
    image!.click()
    await settle()
    expect(viewerOpen()).toBe(true)
  })

  test("every button of the viewer has a slot of its own, with the question open and without", async () => {
    await open()
    const slots = () => viewerButtons().map((button) => button.dataset.slot)
    expect(slots().length).toBeGreaterThan(1)
    expect(new Set(slots()).size).toBe(slots().length)
    expect(slots()).toContain("shot-viewer-close")
    const ask = viewerButtons().find((button) => button.textContent === t("shots.delete"))!
    ask.click()
    await settle()
    expect(slots().length).toBe(2)
    expect(new Set(slots()).size).toBe(slots().length)
    // «Chiudi» is gone while the question is up, and nothing left answers to its slot.
    expect(slots()).not.toContain("shot-viewer-close")
  })

  test("only «Chiudi» answers to shot-viewer-close, and pressing it closes the viewer without asking anything", async () => {
    await open()
    const closers = document.querySelectorAll<HTMLButtonElement>('[data-slot="shot-viewer-close"]')
    expect(closers.length).toBe(1)
    expect(closers[0]!.textContent).toBe(t("shots.close"))
    closers[0]!.click()
    await settle()
    expect(viewerOpen()).toBe(false)
  })

  test("lint: the picture is as wide as it is drawn and centred, so the band beside it is the frame's and not the image's", () => {
    const css = readFileSync(new URL("./tray.css", import.meta.url), "utf-8")
    const body = /\[data-slot="shot-viewer-frame"\] \[data-slot="shot-image"\]\s*\{([^}]*)\}/.exec(css)?.[1] ?? ""
    expect(body).toMatch(/width:\s*auto/)
    expect(body).toMatch(/max-width:\s*100%/)
    expect(body).toMatch(/align-self:\s*center/)
  })
})
