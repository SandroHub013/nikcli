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
function mount(language: "it" | "en") {
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
