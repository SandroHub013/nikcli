import { describe, expect, test } from "bun:test"
import { readBotModels, type BotModelsDeps } from "./bot-models"

/*
 * Full review 2026-10-06, bots 2: the model menu of a bot form must not run nikcli in a folder
 * nobody admitted. The catalog read has no folder unless ADE's server is open on it.
 */

const TEXT = [
  "openai/gpt-x",
  JSON.stringify({ id: "gpt-x", name: "GPT X", providerID: "openai", cost: { input: 1, output: 2 } }),
].join("\n")

function deps(over: Partial<BotModelsDeps> = {}) {
  const reads: (string | undefined)[] = []
  const opened: string[] = []
  const value: BotModelsDeps = {
    openCatalog: async (cwd) => {
      opened.push(cwd)
      return undefined
    },
    readCatalog: async (cwd) => {
      reads.push(cwd)
      return { ok: true, text: TEXT }
    },
    isTest: false,
    ...over,
  }
  return { value, reads, opened }
}

describe("the model menu of a bot form", () => {
  test("with no server open on the folder, nikcli models runs with no folder at all", async () => {
    const { value, reads, opened } = deps()
    const read = await readBotModels("C:/clonato/repo", value)
    expect(opened).toEqual(["C:/clonato/repo"])
    expect(reads).toEqual([undefined])
    expect(read.ok).toBe(true)
  })

  test("with no project at all, the same", async () => {
    const { value, reads, opened } = deps()
    await readBotModels("", value)
    expect(opened).toEqual([])
    expect(reads).toEqual([undefined])
  })

  test("with the server open on the folder, the Chat's catalog answers and nikcli is not run", async () => {
    const { value, reads } = deps({
      openCatalog: async () => ({ providers: [], default: {} }) as never,
    })
    const read = await readBotModels("C:/progetto", value)
    expect(read.ok).toBe(true)
    expect(reads).toEqual([])
  })

  test("a catalog that cannot be read says why, and nothing is kept", async () => {
    const { value } = deps({ readCatalog: async () => ({ ok: false, reason: "nikcli non trovato" }) })
    expect(await readBotModels("C:/clonato/repo", value)).toEqual({ ok: false, reason: "nikcli non trovato" })
  })
})
