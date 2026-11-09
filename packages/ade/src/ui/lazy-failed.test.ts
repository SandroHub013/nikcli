import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { createComponent, render } from "solid-js/web"
import { resetLocaleForTests, t } from "../i18n"
import { compileSolidJsx } from "../test-support/solid-jsx"

compileSolidJsx()
const { lazyComponent } = await import("./lazy-component")

/*
 * prova 4, item 16: a chunk that did not load left a bare box, with a grey
 * «Riprova» on the pane's ground: no frame, no heading, and no «Chiudi», because
 * the pane's own header is inside the module that never arrived, so the pane
 * could be closed only once the chunk came. The failed box now has a frame, a
 * heading, «Riprova» and, when the pane or sheet can be closed, «Chiudi», which
 * closes it without the module.
 */
let dispose: (() => void) | undefined
afterEach(() => {
  dispose?.()
  dispose = undefined
  document.body.innerHTML = ""
  // The UX2-14 tests below end on English. The locale is a global of the whole run, so without this every file that
  // runs after this one read English («Nessun aggiornamento» of the update watch, the voice agent's texts).
  resetLocaleForTests("it")
})
const mount = (component: () => unknown) => {
  const host = document.createElement("div")
  document.body.append(host)
  dispose = render(component as () => never, host)
  return host
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

describe("the box of a screen that did not load", () => {
  const Never = lazyComponent<(props: { onClose?: () => void }) => any>(() => Promise.reject(new Error("chunk missing")))

  test("it is a framed box with a heading, «Riprova» and «Chiudi», and «Chiudi» closes without the module", async () => {
    resetLocaleForTests("it")
    let closed = 0
    const host = mount(() => createComponent(Never, { onClose: () => closed++ }))
    await settle()
    const box = host.querySelector('[data-slot="lazy-failed"]')
    expect(box).not.toBeNull()
    expect(box!.getAttribute("data-component")).toBe("lazy-failed")
    expect(box!.querySelector("h3")?.textContent).toBe("Questa parte di ADE non si è caricata. Premi Riprova; se non basta, chiudi e riapri ADE.")
    expect(box!.querySelector('[data-slot="lazy-retry"]')?.textContent).toBe("Riprova")
    const close = box!.querySelector<HTMLButtonElement>('[data-slot="lazy-close"]')
    expect(close?.textContent).toBe("Chiudi")
    close!.click()
    expect(closed).toBe(1)
  })

  test("English words too", async () => {
    resetLocaleForTests("en")
    const host = mount(() => createComponent(Never, { onClose: () => {} }))
    await settle()
    expect(host.querySelector('[data-slot="lazy-failed"] h3')?.textContent).toBe(
      "This part of ADE did not load. Press Retry; if that isn't enough, close and reopen ADE.",
    )
    expect(host.querySelector('[data-slot="lazy-close"]')?.textContent).toBe("Close")
    resetLocaleForTests("it")
  })

  test("a screen with nothing to close has no «Chiudi», only «Riprova»", async () => {
    const host = mount(() => createComponent(Never, {}))
    await settle()
    expect(host.querySelector('[data-slot="lazy-retry"]')).not.toBeNull()
    expect(host.querySelector('[data-slot="lazy-close"]')).toBeNull()
  })

  test("the frame is styled: a sheet of its own, in tokens, not the browser's bare button", () => {
    const css = readFileSync(new URL("./lazy-failed.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "")
    expect(css).toContain('[data-slot="lazy-failed"]')
    expect(css).toMatch(/border:\s*1px solid var\(--ade-border/)
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/)
  })

  describe("UX2-14: consistent place names and instructions", () => {
    test("lazy.failed uses non-jargon copy and next steps in Italian and English", () => {
      resetLocaleForTests("it")
      expect(t("lazy.failed")).toBe(
        "Questa parte di ADE non si è caricata. Premi Riprova; se non basta, chiudi e riapri ADE.",
      )
      resetLocaleForTests("en")
      expect(t("lazy.failed")).toBe(
        "This part of ADE did not load. Press Retry; if that isn't enough, close and reopen ADE.",
      )
    })

    test("workspace texts refer to cartella dei dati rather than archivio", () => {
      resetLocaleForTests("it")
      expect(t("workspace.unreadableBroken", "copy1")).toContain(
        "nella cartella dei dati di ADE (Impostazioni › Sistema › Informazioni)",
      )
      expect(t("workspace.unreadableBroken", "copy1")).not.toContain("archivio")
      expect(t("workspace.saveFailed")).toContain(
        "nella cartella dei dati di ADE (Impostazioni › Sistema › Informazioni)",
      )
      expect(t("workspace.saveFailed")).not.toContain("archivio")

      resetLocaleForTests("en")
      expect(t("workspace.unreadableBroken", "copy1")).toContain(
        "in ADE's data folder (Settings › System › About)",
      )
      expect(t("workspace.unreadableBroken", "copy1")).not.toContain("storage")
      expect(t("workspace.saveFailed")).toContain(
        "ADE's data folder (Settings › System › About)",
      )
    })

    test("install.stillMissing tells user to click card first and restart if needed", () => {
      resetLocaleForTests("it")
      expect(t("install.stillMissing")).toBe(
        "Non lo trovo ancora. Apri Nuova sessione, clicca la sua scheda e premi Ricontrolla; se non basta, riavvia ADE.",
      )

      resetLocaleForTests("en")
      expect(t("install.stillMissing")).toBe(
        "I can't find it yet. Open New session, click its card and press Check again; if that isn't enough, restart ADE.",
      )
    })

    test("menu paths use › separator", () => {
      resetLocaleForTests("it")
      expect(t("update.failed", "x")).toContain("Notifiche › Controlla aggiornamenti")
      expect(t("record.export.failed", "x")).toContain("Impostazioni › Registrazione")

      resetLocaleForTests("en")
      expect(t("update.failed", "x")).toContain("Notifications › Check for updates")
      expect(t("record.export.failed", "x")).toContain("Settings › Recording")
    })
  })
})
