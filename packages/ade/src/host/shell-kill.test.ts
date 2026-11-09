import { afterAll, describe, expect, mock, test } from "bun:test"

/*
 * SES-12: `kill` marked the session dead before it asked the host to kill the process. When `pty_kill` failed (it
 * returned `false`), a second `kill` found `dead` already set and answered `true` without asking again: the caller
 * believed the process gone, and it ran on. Only a kill that went through is remembered.
 */

const realCore = await import("@tauri-apps/api/core")
const realEvent = await import("@tauri-apps/api/event")

const calls: string[] = []
let killFailures = 1

mock.module("@tauri-apps/api/core", () => ({
  ...realCore,
  invoke: async (cmd: string) => {
    calls.push(cmd)
    if (cmd === "pty_kill" && killFailures > 0) {
      killFailures--
      throw new Error("could not kill")
    }
    return undefined
  },
}))
mock.module("@tauri-apps/api/event", () => ({
  ...realEvent,
  listen: async () => () => {},
}))

afterAll(() => {
  mock.module("@tauri-apps/api/core", () => realCore)
  mock.module("@tauri-apps/api/event", () => realEvent)
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
})

;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = { transformCallback: () => 1 }
// A fresh copy: another test file may have asked for the host before there was a Tauri window, and getHost keeps that answer.
const fresh = "./shell.ts?kill"
const { getHost } = (await import(fresh)) as typeof import("./shell")

async function launch() {
  const host = await getHost()
  return host!.spawn({
    command: "claude",
    args: [],
    cwd: "C:/p",
    onData: () => {},
    onLine: () => {},
    onExit: () => {},
  } as never)
}

describe("a kill that failed is tried again (SES-12)", () => {
  test("the first kill is false, the second really asks the host again and is true", async () => {
    calls.length = 0
    killFailures = 1
    const session = await launch()
    expect(await session.kill()).toBe(false)
    expect(await session.kill()).toBe(true)
    expect(calls.filter((call) => call === "pty_kill")).toHaveLength(2)
  })

  test("once a kill went through, another answers true without asking again", async () => {
    calls.length = 0
    killFailures = 0
    const session = await launch()
    expect(await session.kill()).toBe(true)
    expect(await session.kill()).toBe(true)
    expect(calls.filter((call) => call === "pty_kill")).toHaveLength(1)
  })

  test("a session that is being killed no longer takes writes", async () => {
    calls.length = 0
    killFailures = 1
    const session = await launch()
    await session.kill()
    expect(await session.write("x")).toBe(false)
    expect(calls.includes("pty_write")).toBe(false)
  })
})
