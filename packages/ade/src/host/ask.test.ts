import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { askYesNo, type AskDeps, type AskOptions } from "./ask"

/*
 * F-confirm (found live in B7): in ADE `confirm()` is the dialog plugin's
 * `confirm` command, not granted to the window. It returns a Promise, which
 * an `if` reads as yes, so the editor's questions were never asked.
 */

function deps(over: Partial<AskDeps> = {}): AskDeps & { asked: [string, AskOptions][] } {
  const asked: [string, AskOptions][] = []
  return {
    asked,
    inTauri: () => true,
    load: async () => ({
      ask: async (message, options) => {
        asked.push([message, options])
        return true
      },
    }),
    browserConfirm: () => {
      throw new Error("non nel browser")
    },
    ...over,
  }
}

describe("una domanda sì/no in ADE", () => {
  test("passa dal comando ask del plugin dialog, con il titolo ADE e le etichette date", async () => {
    const d = deps()
    expect(await askYesNo("Chiudo?", { ok: "Chiudi", cancel: "Annulla" }, d)).toBe(true)
    expect(d.asked).toEqual([["Chiudo?", { title: "ADE", kind: "warning", okLabel: "Chiudi", cancelLabel: "Annulla" }]])
  })

  test("il no resta no", async () => {
    expect(await askYesNo("Chiudo?", {}, deps({ load: async () => ({ ask: async () => false }) }))).toBe(false)
  })

  test("una domanda che non si apre è un no, non un sì", async () => {
    const refused = deps({ load: async () => ({ ask: () => Promise.reject("dialog.ask not allowed") }) })
    expect(await askYesNo("Sovrascrivo?", {}, refused)).toBe(false)
    const missing = deps({ load: () => Promise.reject(new Error("no plugin")) })
    expect(await askYesNo("Sovrascrivo?", {}, missing)).toBe(false)
  })

  test("fuori da ADE (la pagina servita da vite) usa la domanda del browser", async () => {
    const seen: string[] = []
    const browser = deps({
      inTauri: () => false,
      browserConfirm: (message) => {
        seen.push(message)
        return false
      },
    })
    expect(await askYesNo("Chiudo?", {}, browser)).toBe(false)
    expect(seen).toEqual(["Chiudo?"])
  })

  test("il workbench non chiama più confirm()", () => {
    const source = readFileSync(join(import.meta.dir, "../surface/workbench.tsx"), "utf8")
    const calls = source.split("\n").filter((line) => /(?<![\w$])(?:window\.)?confirm\s*\(/.test(line) && !/^\s*(?:\/\/|\*)/.test(line))
    expect(calls).toEqual([])
    expect(source).toContain("askYesNo")
  })
})
