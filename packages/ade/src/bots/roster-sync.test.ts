import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { readAgentFile } from "./nikcli"
import { ROSTER_CHECK_MS, rosterChanged } from "./roster-sync"

/* Verifiche: a `model:` added from outside ADE showed «a pagamento» until a restart. */

const read = (text: string) => readAgentFile({ path: "C:/p/.nikcli/agent/secondo.md", scope: "project", text })
const before = read("---\ndescription: prova\nmode: primary\n---\nSei secondo.\n")
const after = read("---\ndescription: prova\nmode: primary\nmodel: openrouter/nvidia/nemotron-3.5-lightning:free\n---\nSei secondo.\n")

describe("the roster and its files", () => {
  test("a model added to a file is a change; the same files are not", () => {
    expect(rosterChanged([before], [after])).toBe(true)
    expect(rosterChanged([before], [read("---\ndescription: prova\nmode: primary\n---\nSei secondo.\n")])).toBe(false)
    expect(rosterChanged(undefined, [])).toBe(false)
    expect(rosterChanged([before], [])).toBe(true)
  })

  test("the timer it is looked at on is short enough for a model added outside to show up", () => {
    expect(ROSTER_CHECK_MS).toBeLessThanOrEqual(30_000)
  })

  test("lint: the roster is read again on focus, on that timer, and when the room form opens", () => {
    const bots = readFileSync(new URL("./bots.tsx", import.meta.url), "utf8")
    expect(bots).toContain("every(ROSTER_CHECK_MS, () => void checkFiles())")
    expect(bots).toContain('window.addEventListener("focus", () => void checkFiles())')
    expect(bots).toContain("if (form) void checkFiles()")
    expect(bots).toContain("if (rosterChanged(roster(), await listBots(roots()))) reload()")
  })
})
