import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { Host } from "../host/shell"
import type { AgentFile } from "./nikcli"
import { deleteBot, GATEWAY_PLATFORMS } from "./store"

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
  test("its token leaves every platform, and its gateway stops, before its file goes", async () => {
    const calls: string[] = []
    const failure = await deleteBot(BOT, async (bot, platform) => void calls.push(`token:${platform}:${bot}`), host(calls))
    expect(failure).toBeUndefined()
    expect(calls).toEqual([...GATEWAY_PLATFORMS.map((platform) => `token:${platform}:${BOT.path}`), "file:" + BOT.path])
  })

  test("a token that cannot be cleared keeps the file, and says which", async () => {
    const calls: string[] = []
    const failure = await deleteBot(
      BOT,
      async (_bot, platform) => {
        if (platform === "discord") throw new Error("portachiavi di sistema non accessibile")
      },
      host(calls),
    )
    expect(failure).toContain("discord")
    expect(failure).toContain("portachiavi di sistema non accessibile")
    expect(calls).toEqual([])
  })

  test("the platforms are the Rust side's, every one", () => {
    const source = readFileSync(join(import.meta.dir, "..", "..", "src-tauri", "src", "gateway", "adapter.rs"), "utf8")
    const body = source.slice(source.indexOf("pub enum Platform {"), source.indexOf("}", source.indexOf("pub enum Platform {")))
    const variants = body
      .split("\n")
      .map((line) => line.trim())
      .filter((line, index, lines) => /^[A-Z][a-z]+,$/.test(line) && lines[index - 1] !== "#[cfg(test)]")
      .map((line) => line.slice(0, -1).toLowerCase())
    const ours: string[] = [...GATEWAY_PLATFORMS]
    expect(ours.sort()).toEqual(variants.sort())
  })
})
