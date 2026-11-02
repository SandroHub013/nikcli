import { afterAll, describe, expect, mock, test } from "bun:test"

/*
 * The lines of one chunk are read together. A flood's chunk is 256 KB, about 2500 lines, and the page wrote its store
 * once for each: 94% of its time went there, xterm took 0.6%, and a program printing 30 MiB froze the whole window for
 * a minute (live test of 2026-11-02, E2). The real `spawn`, with a fake event channel: only the host knows where a
 * chunk ends.
 */

const realCore = await import("@tauri-apps/api/core")
const realEvent = await import("@tauri-apps/api/event")

const handlers = new Map<string, (event: { payload: unknown }) => void>()

mock.module("@tauri-apps/api/core", () => ({
  ...realCore,
  invoke: async () => undefined,
}))
mock.module("@tauri-apps/api/event", () => ({
  ...realEvent,
  listen: async (topic: string, handler: (event: { payload: unknown }) => void) => {
    handlers.set(topic, handler)
    return () => {}
  },
}))

afterAll(() => {
  mock.module("@tauri-apps/api/core", () => realCore)
  mock.module("@tauri-apps/api/event", () => realEvent)
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
})

;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
// A fresh copy: another test file may have asked for the host before there was a Tauri window, and getHost keeps that answer.
const fresh = "./shell.ts?lines"
const { getHost } = (await import(fresh)) as typeof import("./shell")

async function launch(linesTogether?: (read: () => void) => void) {
  handlers.clear()
  const host = await getHost()
  const seen: string[] = []
  await host!.spawn({
    command: "cmd",
    args: [],
    cwd: "C:/p",
    onLine: (line: string) => seen.push(line),
    onExit: () => {},
    ...(linesTogether ? { linesTogether } : {}),
  } as never)
  const topic = [...handlers.keys()].find((name) => name.startsWith("pty:data:"))!
  return { seen, chunk: (data: string) => handlers.get(topic)!({ payload: { id: "x", data, bytes: data.length } }) }
}

describe("a chunk's lines, read together", () => {
  test("once per chunk, and every line of the chunk is read inside it", async () => {
    const calls: number[] = []
    let inside = 0
    const { seen, chunk } = await launch((read) => {
      const before = seen.length
      inside++
      read()
      inside--
      calls.push(seen.length - before)
    })
    chunk("uno\r\ndue\r\ntre\r\n")
    chunk("quattro\r\n")
    expect(calls).toEqual([3, 1])
    expect(seen).toEqual(["uno", "due", "tre", "quattro"])
    expect(inside).toBe(0)
  })

  test("a line split between two chunks comes out whole, in the chunk that ends it", async () => {
    const calls: number[] = []
    const { seen, chunk } = await launch((read) => {
      const before = seen.length
      read()
      calls.push(seen.length - before)
    })
    chunk("metà")
    chunk(" e fine\r\n")
    expect(seen).toEqual(["metà e fine"])
    expect(calls).toEqual([0, 1])
  })

  test("a caller that asks for nothing still hears every line", async () => {
    const { seen, chunk } = await launch()
    chunk("uno\r\ndue\r\n")
    expect(seen).toEqual(["uno", "due"])
  })
})
