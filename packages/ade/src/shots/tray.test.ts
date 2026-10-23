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

  test("with no folder at all, still offers the picker", () => {
    const host = mount({ unavailable: true, onChoose: () => {} })

    expect(host.querySelector('[data-slot="shot-tray-empty"]')?.textContent).toBe(t("shots.noFolder"))
    expect(host.querySelector('[data-slot="shot-tray-choose"]')).not.toBeNull()
    expect(host.querySelector('[data-slot="shot-tray-folder"]')).toBeNull()
  })
})
