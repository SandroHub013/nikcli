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

/*
 * A ZIP, APK, JAR or AAB lists what it holds, from the host, sortable, at
 * most 2000 rows; an APK says who it is first (pannello-file-binario, point 4).
 */
describe("an archive's contents in the card", () => {
  const entries = [
    { path: "res/b.png", size: 300 },
    { path: "AndroidManifest.xml", size: 5 },
    { path: "classes.dex", size: 4096 },
  ]
  const listing = {
    entries,
    total: 3,
    android: { package: "com.fabioland.app", versionName: "0.2.0", versionCode: "1", minSdk: "24", targetSdk: "36" },
  }
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
  const rows = (host: HTMLElement) =>
    Array.from(host.querySelectorAll('[data-slot="archive-row"]'), (row) =>
      Array.from(row.querySelectorAll("td"), (cell) => cell.textContent),
    )

  test("the files are listed by path, with their sizes, and the APK's identity on top", async () => {
    const asked: string[] = []
    const { host, slot } = mount("it", {
      listArchive: async (path: string) => {
        asked.push(path)
        return listing
      },
    })
    await flush()
    expect(asked).toEqual(["C:/Users/me/Fabioland/Fabioland-0.1.1-preview.apk"])
    expect(rows(host)).toEqual([
      ["AndroidManifest.xml", "5 byte"],
      ["classes.dex", "4 KB"],
      ["res/b.png", "300 byte"],
    ])
    expect(slot("android-package")).toBe("com.fabioland.app")
    expect(slot("android-version-name")).toBe("0.2.0")
    expect(slot("android-version-code")).toBe("1")
    expect(slot("android-min-sdk")).toBe("24")
    expect(slot("android-target-sdk")).toBe("36")
    expect(slot("archive-count")).toBe("3 file")
    expect(slot("archive-more")).toBeNull()
  })

  test("a header click sorts by size, largest first, and a second click reverses it", async () => {
    const { host } = mount("en", { listArchive: async () => listing })
    await flush()
    const size = host.querySelector<HTMLButtonElement>('[data-slot="archive-sort-size"]')!
    size.click()
    expect(rows(host).map(([path]) => path)).toEqual(["classes.dex", "res/b.png", "AndroidManifest.xml"])
    size.click()
    expect(rows(host).map(([path]) => path)).toEqual(["AndroidManifest.xml", "res/b.png", "classes.dex"])
    host.querySelector<HTMLButtonElement>('[data-slot="archive-sort-path"]')!.click()
    expect(rows(host).map(([path]) => path)).toEqual(["AndroidManifest.xml", "classes.dex", "res/b.png"])
  })

  test("past 2000 rows the card says how many more there are", async () => {
    const many = Array.from({ length: 2500 }, (_, i) => ({ path: `f/${String(i).padStart(4, "0")}`, size: i }))
    const { host, slot } = mount("it", { listArchive: async () => ({ entries: many, total: 2600 }) })
    await flush()
    expect(rows(host).length).toBe(2000)
    expect(slot("archive-more")).toBe("e altre 600 voci")
    expect(host.querySelector('[data-slot="android-package"]')).toBeNull()
  })

  test("an archive that cannot be read leaves the card, with the reason, and no manifest", async () => {
    const { host, slot } = mount("en", {
      listArchive: async () => {
        throw new Error("invalid Zip archive")
      },
    })
    await flush()
    expect(slot("binary-name")).toBe("Fabioland-0.1.1-preview.apk")
    expect(slot("archive-failed")).toBe("Contents not readable: invalid Zip archive")
    expect(rows(host)).toEqual([])
  })

  test("a file that is not an archive is not listed", async () => {
    const asked: string[] = []
    resetLocaleForTests("it")
    const host = document.createElement("div")
    document.body.append(host)
    dispose = render(
      () =>
        createComponent(FileView, {
          path: "C:/p/setup.exe",
          kind: "text",
          asText: false,
          buffer: undefined,
          error: "file binario, 10 byte",
          binary: { bytes: 10, head: [0x4d, 0x5a] },
          onChange: () => {},
          onSave: () => {},
          listArchive: async (path: string) => {
            asked.push(path)
            return listing
          },
        }),
      host,
    )
    await flush()
    expect(asked).toEqual([])
    expect(host.querySelector('[data-slot="archive"]')).toBeNull()
  })
})
