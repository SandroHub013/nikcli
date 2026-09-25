import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { askUser, type AskOptions } from "./ask"

/*
 * B7, live in ADE Test: the trust question went through window.confirm, which
 * in ADE is the dialog plugin's `confirm` command — not granted to the window,
 * so it rejected and no project bot ever started.
 */

describe("la domanda di fiducia dei bot", () => {
  test("passa dal comando ask del plugin dialog, l'unico che la finestra ha", async () => {
    const calls: [string, AskOptions][] = []
    const yes = await askUser("Lo usi?", async () => ({
      ask: async (message, options) => {
        calls.push([message, options])
        return true
      },
    }))
    expect(yes).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]![0]).toBe("Lo usi?")
    expect(calls[0]![1].title).toBe("ADE")
    expect(calls[0]![1].okLabel).not.toBe("")
    expect(calls[0]![1].cancelLabel).not.toBe("")
  })

  test("il no resta no", async () => {
    expect(await askUser("Lo usi?", async () => ({ ask: async () => false }))).toBe(false)
  })

  test("la sezione Bot non usa window.confirm", () => {
    const capabilities = readFileSync(join(import.meta.dir, "../../src-tauri/capabilities/default.json"), "utf8")
    expect(capabilities).toContain('"dialog:allow-ask"')
    expect(capabilities).not.toContain('"dialog:allow-confirm"')
    const bots = readFileSync(join(import.meta.dir, "bots.tsx"), "utf8")
    expect(bots).not.toMatch(/\bconfirm\s*\(/)
    expect(bots).toContain("askUser")
  })
})
