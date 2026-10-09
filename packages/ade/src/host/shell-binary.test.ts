import { afterAll, describe, expect, mock, test } from "bun:test"
import { binaryFromHost } from "../editor/binary-file"

/*
 * A file that is not text comes back from `read_text_file` as a structured
 * failure: its kind, its size, its modification time and its first bytes. The
 * file pane reads those fields, not a sentence: the Italian «file binario, N
 * byte» built in Rust used to be matched by a regex, and the English pane
 * showed it half in Italian (pannello-file-binario, point 1).
 *
 * The message stays the sentence the other callers already know (search,
 * links), so they keep skipping a binary as before.
 */

const realCore = await import("@tauri-apps/api/core")
const realEvent = await import("@tauri-apps/api/event")

let failure: unknown

mock.module("@tauri-apps/api/core", () => ({
  ...realCore,
  invoke: async (cmd: string) => {
    if (cmd === "read_text_file") throw failure
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

;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
// A fresh copy: another test file may have asked for the host before there was a Tauri window, and getHost keeps that answer.
const fresh = "./shell.ts?binary"
const { getHost } = (await import(fresh)) as typeof import("./shell")

async function readFails(): Promise<unknown> {
  const host = await getHost()
  return host!.readTextFile!("C:/p/app.apk").then(
    () => {
      throw new Error("the read should have failed")
    },
    (error: unknown) => error,
  )
}

describe("a binary file read as text", () => {
  test("fails with its size, its time and its first bytes, as fields", async () => {
    failure = { kind: "binary", bytes: 135800631, modified: 1791561441000, head: [0x50, 0x4b, 0x03, 0x04] }
    const error = await readFails()
    expect(binaryFromHost(error)).toEqual({
      bytes: 135800631,
      modified: 1791561441000,
      head: [0x50, 0x4b, 0x03, 0x04],
    })
  })

  test("keeps the message the search and the links already skip", async () => {
    failure = { kind: "binary", bytes: 5, head: [] }
    const error = await readFails()
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe("file binario, 5 byte")
  })

  test("any other failure is passed on as it came, and is not a binary", async () => {
    failure = "impossibile trovare il file"
    const error = await readFails()
    expect(error).toBe("impossibile trovare il file")
    expect(binaryFromHost(error)).toBeUndefined()
    expect(binaryFromHost(new Error("file binario, 5 byte"))).toBeUndefined()
  })
})
