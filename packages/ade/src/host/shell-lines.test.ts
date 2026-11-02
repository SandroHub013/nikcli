import { afterAll, describe, expect, mock, test } from "bun:test"

/*
 * The lines of one chunk are read together. A flood's chunk is 256 KB, about 2500 lines, and the page wrote its store
 * once for each: 94% of its time went there, xterm took 0.6%, and a program printing 30 MiB froze the whole window for
 * a minute (live test of 2026-11-02, E2). The real `spawn`, with the host faked at the end of its channel: only the host
 * knows where a chunk ends.
 */

const realCore = await import("@tauri-apps/api/core")

/** The host's end of a session's channel: what `Channel::send` reaches, with the index it counts. */
type Raw = (message: { message: unknown; index: number }) => void

let raw: Raw | undefined
let spawnArgs: Record<string, unknown> | undefined

mock.module("@tauri-apps/api/core", () => ({
  ...realCore,
  invoke: async (command: string, args?: Record<string, unknown>) => {
    if (command === "pty_spawn") spawnArgs = args
    return undefined
  },
}))

afterAll(() => {
  mock.module("@tauri-apps/api/core", () => realCore)
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
})

// The real `Channel`, the one that keeps a session's messages in order: only what the host's script calls is faked.
;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
  transformCallback: (callback: Raw) => {
    raw = callback
    return 1
  },
  unregisterCallback: () => {},
}
// A fresh copy: another test file may have asked for the host before there was a Tauri window, and getHost keeps that answer.
const fresh = "./shell.ts?lines"
const { getHost } = (await import(fresh)) as typeof import("./shell")

async function launch(options: Record<string, unknown> = {}) {
  raw = undefined
  const host = await getHost()
  const seen: string[] = []
  const exits: Array<number | null> = []
  const session = await host!.spawn({
    command: "cmd",
    args: [],
    cwd: "C:/p",
    onLine: (line: string) => seen.push(line),
    onExit: (code: number | null) => exits.push(code),
    ...options,
  } as never)
  const channel = raw!
  let index = 0
  return {
    session,
    seen,
    exits,
    chunk: (data: string) => channel({ message: { kind: "data", data, bytes: data.length }, index: index++ }),
    exit: (code: number | null) => channel({ message: { kind: "exit", code }, index: index++ }),
    at: (i: number, message: unknown) => channel({ message, index: i }),
  }
}

describe("a chunk's lines, read together", () => {
  test("once per chunk, and every line of the chunk is read inside it", async () => {
    let inside = 0
    const counts: number[] = []
    const { seen, chunk } = await launch({
      linesTogether: (read: () => void) => {
        const before = seen.length
        inside++
        read()
        inside--
        counts.push(seen.length - before)
      },
    })
    chunk("uno\r\ndue\r\ntre\r\n")
    chunk("quattro\r\n")
    expect(counts).toEqual([3, 1])
    expect(seen).toEqual(["uno", "due", "tre", "quattro"])
    expect(inside).toBe(0)
  })

  test("a line split between two chunks comes out whole, in the chunk that ends it", async () => {
    const counts: number[] = []
    const { seen, chunk } = await launch({
      linesTogether: (read: () => void) => {
        const before = seen.length
        read()
        counts.push(seen.length - before)
      },
    })
    chunk("metà")
    chunk(" e fine\r\n")
    expect(seen).toEqual(["metà e fine"])
    expect(counts).toEqual([0, 1])
  })

  test("a caller that asks for nothing still hears every line", async () => {
    const { seen, chunk } = await launch()
    chunk("uno\r\ndue\r\n")
    expect(seen).toEqual(["uno", "due"])
  })
})

/*
 * Output and exit on one channel. An event is a script with the whole chunk as a literal in it, and V8 keeps both in the
 * old space: 270 MB of output left 526 MB of garbage in 30 s, and a flood took the renderer past 2 GB (live test of
 * 2026-11-02). A channel's large message is fetched instead, so the flood stops being a script.
 */
describe("a session's channel", () => {
  test("the host is given the channel under the name its command takes", async () => {
    await launch()
    expect(spawnArgs?.events).toBeInstanceOf(realCore.Channel)
  })

  test("the tail of a program comes before its exit, even when the exit reaches the page first", async () => {
    const { seen, exits, at } = await launch()
    at(1, { kind: "exit", code: 3 })
    expect(exits).toEqual([])
    at(0, { kind: "data", data: "ultima riga\r\nsenza a capo", bytes: 25 })
    expect(seen).toEqual(["ultima riga", "senza a capo"])
    expect(exits).toEqual([3])
  })

  /*
   * `Channel` counts a message only after its handler has returned. A handler that threw would leave the count where it
   * was, and every later message of the session, its exit included, would wait for ever behind it.
   */
  test("a chunk that throws does not hold back the ones behind it, or the exit", async () => {
    const lines: string[] = []
    const realError = console.error
    console.error = () => {}
    try {
      const { exits, chunk, exit } = await launch({
        onData: (data: string) => {
          if (data.startsWith("rotto")) throw new Error("boom")
        },
        onLine: (line: string) => {
          if (line === "esplode") throw new Error("boom")
          lines.push(line)
        },
      })
      chunk("rotto\r\n")
      chunk("esplode\r\ndopo\r\n")
      chunk("sano\r\n")
      exit(0)
      expect(lines).toEqual(["rotto", "dopo", "sano"])
      expect(exits).toEqual([0])
    } finally {
      console.error = realError
    }
  })

  test("after a kill the page reads nothing more from the session", async () => {
    const { session, seen, exits, chunk, exit } = await launch()
    chunk("prima\r\n")
    await session.kill()
    chunk("dopo\r\n")
    exit(0)
    expect(seen).toEqual(["prima"])
    expect(exits).toEqual([])
  })
})
