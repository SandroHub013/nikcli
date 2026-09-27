import { describe, expect, test } from "bun:test"
import { TALK_ARCHIVE_MAX, type Talk } from "../talk"
import { createGatewayThreads, gatewayThreadKey, keptThread, type ThreadDisk } from "./threads"

const SECRET = "sk-or-v1-abcdefghijklmnopqrstuvwxyz0123456789"

function diskOf(): ThreadDisk & { readonly data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  }
}

function talkWith(output: string): Talk {
  return {
    messages: [
      { id: "t1", role: "tool", tool: "bash", text: "env", output, at: 1 },
      { id: "u1", role: "user", text: "ciao", at: 2 },
    ],
    status: "idle",
    tokens: 4,
    costUsd: 0,
    sessionId: "s-1",
    updatedAt: 2,
  }
}

describe("a gateway chat's thread", () => {
  test("a secret in tool output does not land on disk, and the thread stays under its cap", () => {
    const disk = diskOf()
    const threads = createGatewayThreads(disk)
    const key = gatewayThreadKey("C:/p/.nikcli/agent/revisore.md", "telegram", "c42")
    threads.save(key, talkWith(`${SECRET}${"y".repeat(300_000)}`))
    const raw = disk.data.get(key)
    expect(raw).toBeDefined()
    expect(raw).not.toContain(SECRET)
    expect(raw).toContain("[nascosto]")
    expect(raw!.length).toBeLessThanOrEqual(TALK_ARCHIVE_MAX)
  })

  test("a reload does not lose the conversation, and another chat is a different key", () => {
    const disk = diskOf()
    const key = gatewayThreadKey("C:/p/.nikcli/agent/revisore.md", "telegram", "c42")
    const other = gatewayThreadKey("C:/p/.nikcli/agent/revisore.md", "telegram", "c99")
    createGatewayThreads(disk).save(key, keptThread(talkWith("ok"), talkWith("ancora")))
    const reloaded = createGatewayThreads(disk).read(key)
    expect(reloaded.messages.filter((message) => message.role === "user").map((message) => message.text)).toEqual([
      "ciao",
      "ciao",
    ])
    expect(reloaded.sessionId).toBe("s-1")
    expect(createGatewayThreads(disk).read(other).messages).toHaveLength(0)
    createGatewayThreads(disk).forget(key)
    expect(disk.data.has(key)).toBe(false)
  })
})
