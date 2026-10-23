import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { compileSolidJsx } from "../test-support/solid-jsx"
import { resetLocaleForTests } from "../i18n/locale"

if (typeof document === "undefined") GlobalRegistrator.register()
compileSolidJsx()

const { createComponent, render } = await import("solid-js/web")
const { ShotTray } = await import("./tray")
const { t } = await import("../i18n")

let dispose: (() => void) | undefined
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
