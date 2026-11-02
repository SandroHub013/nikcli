import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { orderedWrites } from "./ordered-writes"

/** A `send` whose calls stay open until the test answers them. */
function held() {
  const calls: { data: string; answer: (error?: Error) => void }[] = []
  const send = (data: string) =>
    new Promise<void>((resolve, reject) => {
      calls.push({ data, answer: (error) => (error ? reject(error) : resolve()) })
    })
  return { calls, send }
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("orderedWrites", () => {
  test("only one write is in flight: the next waits for the answer", async () => {
    const { calls, send } = held()
    const write = orderedWrites(send)
    write("git status")
    write("\r")
    expect(calls.map((call) => call.data)).toEqual(["git status"])
    calls[0]!.answer()
    await settled()
    expect(calls.map((call) => call.data)).toEqual(["git status", "\r"])
  })

  test("the writes go in the order they came, each on its own", async () => {
    const { calls, send } = held()
    const write = orderedWrites(send)
    for (const key of ["a", "b", "c", "\r"]) write(key)
    for (let i = 0; i < 4; i += 1) {
      calls[i]!.answer()
      await settled()
    }
    expect(calls.map((call) => call.data)).toEqual(["a", "b", "c", "\r"])
  })

  test("a write that fails does not stop the ones behind it", async () => {
    const { calls, send } = held()
    const write = orderedWrites(send)
    write("a")
    write("b")
    calls[0]!.answer(new Error("il terminale non sta leggendo"))
    await settled()
    expect(calls.map((call) => call.data)).toEqual(["a", "b"])
  })

  test("after the queue empties, the next write goes at once", async () => {
    const { calls, send } = held()
    const write = orderedWrites(send)
    write("a")
    calls[0]!.answer()
    await settled()
    write("b")
    expect(calls.map((call) => call.data)).toEqual(["a", "b"])
  })

  test("each write answers whether the pane took it", async () => {
    const { calls, send } = held()
    const write = orderedWrites(send)
    const first = write("a")
    const second = write("b")
    calls[0]!.answer(new Error("il terminale non sta leggendo"))
    expect(await first).toBe(false)
    await settled()
    calls[1]!.answer()
    expect(await second).toBe(true)
  })

  test("a session that has ended answers false, without an invoke", () => {
    const shell = readFileSync(join(import.meta.dir, "shell.ts"), "utf8")
    const write = shell.slice(shell.indexOf("write: (data) => {"))
    expect(write.slice(0, 120)).toContain("if (dead) return Promise.resolve(false)")
    expect(write.slice(0, 120)).toContain("return sendToPane(data)")
  })

  test("a pane's writes go through it, not straight to invoke", () => {
    const shell = readFileSync(join(import.meta.dir, "shell.ts"), "utf8")
    expect(shell).toContain('orderedWrites((data) => invoke("pty_write", { id, data }))')
    expect(shell).not.toContain('void invoke("pty_write"')
  })
})
