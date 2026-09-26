import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { hideButtons, hideChoice, markTrayNoticed, planHide, TRAY_NOTICE_KEY, trayNoticed } from "./tray-hide"

/* G11 review, M1: hiding to the tray is said, and with sessions at work asked. */
describe("the X with a gateway on", () => {
  test("with sessions at work it asks, every time", () => {
    expect(planHide({ working: 2, noticed: false })).toEqual({ kind: "ask", working: 2 })
    expect(planHide({ working: 1, noticed: true })).toEqual({ kind: "ask", working: 1 })
  })

  test("without, the note once, then it just hides", () => {
    expect(planHide({ working: 0, noticed: false })).toEqual({ kind: "notice" })
    expect(planHide({ working: 0, noticed: true })).toEqual({ kind: "hide" })
  })

  test("the answers; the dialog's X and anything unknown keep the window", () => {
    const buttons = hideButtons()
    expect(hideChoice(buttons.yes, buttons)).toBe("hide")
    expect(hideChoice(buttons.no, buttons)).toBe("close-sessions")
    expect(hideChoice(buttons.cancel, buttons)).toBe("keep")
    expect(hideChoice(undefined, buttons)).toBe("keep")
    expect(hideChoice("Cancel", buttons)).toBe("keep")
    expect(new Set([buttons.yes, buttons.no, buttons.cancel]).size).toBe(3)
  })

  test("the note is remembered; storage that fails does not bring it back every time", () => {
    const store = new Map<string, string>()
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) }
    expect(trayNoticed(storage)).toBe(false)
    markTrayNoticed(storage)
    expect(store.get(TRAY_NOTICE_KEY)).toBe("1")
    expect(trayNoticed(storage)).toBe(true)
    const broken = {
      getItem: () => {
        throw new Error("bloccato")
      },
      setItem: () => {
        throw new Error("bloccato")
      },
    }
    expect(trayNoticed(broken)).toBe(true)
    expect(() => markTrayNoticed(broken)).not.toThrow()
    expect(trayNoticed(undefined)).toBe(true)
  })

  test("lint: the hide handler asks, closes the sessions on that answer, and only then hides", () => {
    const view = readFileSync(new URL("./workbench.tsx", import.meta.url), "utf8")
    const start = view.indexOf('listen<{ requestId?: number }>("ade-window-hide-requested"')
    expect(start).toBeGreaterThan(0)
    const block = view.slice(start, view.indexOf('listen("ade-window-shown"', start))
    expect(block).toContain('invoke<boolean>("ade_tray_take", { requestId })')
    expect(block).toContain("planHide({ working: working.length, noticed: trayNoticed(storage) })")
    expect(block).toContain('if (choice === "keep") return')
    expect(block).toContain('if (choice === "close-sessions") await closer.closeAll(working.map((pane) => pane.id))')
    expect(block.indexOf("closer.closeAll")).toBeLessThan(block.indexOf('invoke("ade_hide_to_tray")'))
    expect(block).toContain("if (voiceEngine.isRunning()) void voiceEngine.pauseListening()")
    expect(view).toContain("isHidden: () => hiddenInTray,")
  })

  test("lint: the main window capability grants dialog:allow-message", () => {
    const capabilities = JSON.parse(readFileSync(new URL("../../src-tauri/capabilities/default.json", import.meta.url), "utf8"))
    expect(capabilities.permissions).toContain("dialog:allow-message")
  })
})
