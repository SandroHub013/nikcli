import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { compileSolidJsx } from "../test-support/solid-jsx"
import { resetLocaleForTests } from "../i18n/locale"

if (typeof document === "undefined") GlobalRegistrator.register()
compileSolidJsx()

const { createComponent, render } = await import("solid-js/web")
const { FileView } = await import("./file-view")

let dispose: (() => void) | undefined
afterEach(() => {
  dispose?.()
  dispose = undefined
  document.body.innerHTML = ""
})
afterAll(() => resetLocaleForTests("it"))

/*
 * A binary file gets a card instead of one monospace line: an icon, its name,
 * what it is, how big, when it changed (pannello-file-binario, point 2).
 */
function mount(language: "it" | "en", extra: Record<string, unknown> = {}) {
  resetLocaleForTests(language)
  const host = document.createElement("div")
  document.body.append(host)
  dispose = render(
    () =>
      createComponent(FileView, {
        path: "C:/Users/me/Fabioland/Fabioland-0.1.1-preview.apk",
        kind: "text",
        asText: false,
        buffer: undefined,
        error: "file binario, 135800631 byte",
        binary: { bytes: 135800631, modified: Date.UTC(2026, 9, 9, 12, 0), head: [0x50, 0x4b, 0x03, 0x04] },
        onChange: () => {},
        onSave: () => {},
        ...extra,
      }),
    host,
  )
  const slot = (name: string) => host.querySelector(`[data-slot="${name}"]`)?.textContent ?? null
  return { host, slot }
}

describe("the binary file card", () => {
  test("in Italian: name, kind, size with a comma, date", () => {
    const { host, slot } = mount("it")
    expect(host.querySelector('[data-slot="binary-card"]')).not.toBeNull()
    expect(host.querySelector('[data-slot="binary-icon"] svg')).not.toBeNull()
    expect(slot("binary-name")).toBe("Fabioland-0.1.1-preview.apk")
    expect(slot("binary-type")).toBe("Pacchetto Android (APK)")
    expect(slot("binary-size")).toBe("129,5 MB")
    expect(slot("binary-modified")).toContain("2026")
    // The raw sentence of the old pane is gone.
    expect(host.textContent).not.toContain("135800631")
    expect(host.querySelector('[data-slot="file-message"]')).toBeNull()
  })

  test("in English: nothing Italian left", () => {
    const { host, slot } = mount("en")
    expect(slot("binary-type")).toBe("Android package (APK)")
    expect(slot("binary-size")).toBe("129.5 MB")
    expect(host.textContent).not.toContain("binario")
    expect(host.textContent).not.toContain("byte,")
  })
})

/*
 * Two things to do with a file ADE cannot show: find it on disk, or take its
 * path elsewhere. Never «Apri» or «Esegui»: the pane does not run what it
 * shows (pannello-file-binario, point 3).
 */
describe("the binary file card's actions", () => {
  const PATH = "C:/Users/me/Fabioland/Fabioland-0.1.1-preview.apk"
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

  test("«Mostra nella cartella» asks the host to reveal this file", async () => {
    const revealed: string[] = []
    const { host } = mount("it", { revealFile: async (path: string) => void revealed.push(path) })
    const button = host.querySelector<HTMLButtonElement>('[data-slot="binary-reveal"]')!
    expect(button.textContent).toBe("Mostra nella cartella")
    button.click()
    await flush()
    expect(revealed).toEqual([PATH])
  })

  test("a reveal the host refuses says why, in the card", async () => {
    const { host, slot } = mount("en", {
      revealFile: async () => {
        throw new Error("not a file")
      },
    })
    host.querySelector<HTMLButtonElement>('[data-slot="binary-reveal"]')!.click()
    await flush()
    expect(slot("binary-status")).toBe("not a file")
  })

  test("«Copia percorso» puts the path on the clipboard, as Windows writes it, and says so", async () => {
    const copied: string[] = []
    const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard")
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (text: string) => void copied.push(text) },
    })
    try {
      const { host, slot } = mount("it", { revealFile: async () => {} })
      const button = host.querySelector<HTMLButtonElement>('[data-slot="binary-copy"]')!
      expect(button.textContent).toBe("Copia percorso")
      button.click()
      await flush()
      expect(copied).toEqual(["C:\\Users\\me\\Fabioland\\Fabioland-0.1.1-preview.apk"])
      expect(slot("binary-status")).toBe("Copiato")
    } finally {
      if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard)
      else delete (navigator as unknown as Record<string, unknown>).clipboard
    }
  })

  test("the only actions are those two: nothing opens or runs the file", () => {
    const { host } = mount("it", { revealFile: async () => {} })
    const labels = Array.from(host.querySelectorAll("button"), (button) => button.textContent)
    expect(labels).toEqual(["Mostra nella cartella", "Copia percorso"])
  })
})
