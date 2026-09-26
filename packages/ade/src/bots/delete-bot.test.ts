import { describe, expect, test } from "bun:test"
import type { Host } from "../host/shell"
import type { AgentFile } from "./nikcli"
import { deleteBot } from "./store"

const BOT = { path: "C:/progetto/.nikcli/agent/aiuto.md" } as AgentFile

function host(calls: string[]): () => Promise<Host> {
  return async () =>
    ({
      deleteBotFile: async (path: string) => {
        calls.push("file:" + path)
        return null
      },
    }) as unknown as Host
}

describe("deleting a bot", () => {
  test("its gateways are forgotten, tokens and authorized senders, before its file goes", async () => {
    const calls: string[] = []
    const failure = await deleteBot(BOT, async (bot) => void calls.push("forget:" + bot), host(calls))
    expect(failure).toBeUndefined()
    expect(calls).toEqual(["forget:" + BOT.path, "file:" + BOT.path])
  })

  test("gateways that cannot be forgotten keep the file, and say why", async () => {
    const calls: string[] = []
    const failure = await deleteBot(
      BOT,
      async () => {
        throw new Error("portachiavi di sistema non accessibile")
      },
      host(calls),
    )
    expect(failure).toContain("portachiavi di sistema non accessibile")
    expect(calls).toEqual([])
  })

  test("the command is one the app registers", async () => {
    const { readFileSync } = await import("node:fs")
    const { join } = await import("node:path")
    const lib = readFileSync(join(import.meta.dir, "..", "..", "src-tauri", "src", "lib.rs"), "utf8")
    expect(lib).toContain("gateway::gateway_forget_bot,")
  })
})
