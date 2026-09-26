import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { oneAtATime } from "./one-at-a-time"

/*
 * Review of the frontend, ALTO 3: two reopens of one pane, the second while
 * the first was still awaiting, started two processes for it.
 */

describe("one start per pane at a time (ALTO 3)", () => {
  test("a second run for the same pane, while the first is under way, starts nothing", async () => {
    const guard = oneAtATime()
    let started = 0
    let finish!: () => void
    const first = guard.run("p1", async () => {
      await new Promise<void>((resolve) => (finish = resolve))
      started++
    })
    expect(guard.busy("p1")).toBe(true)
    expect(await guard.run("p1", async () => void started++)).toBe(false)
    finish()
    expect(await first).toBe(true)
    expect(started).toBe(1)
    expect(guard.busy("p1")).toBe(false)
  })

  test("another pane is not held up, and a failed run frees its pane", async () => {
    const guard = oneAtATime()
    let finish!: () => void
    const slow = guard.run("p1", () => new Promise<void>((resolve) => (finish = resolve)))
    expect(await guard.run("p2", async () => {})).toBe(true)
    finish()
    await slow
    await guard.run("p3", async () => { throw new Error("spawn") }).catch(() => undefined)
    expect(guard.busy("p3")).toBe(false)
  })

  test("reopen and the restore start a pane through the same guard", () => {
    const source = readFileSync(join(import.meta.dir, "workbench.tsx"), "utf8")
    const reopen = source.slice(source.indexOf("const reopen = async "), source.indexOf("const reopenPane = async "))
    expect(reopen).toContain("reopening.run(given.id, () => reopenPane(given, line, claims))")
    expect(source).toContain(
      'void reopening.run(session.pane.id, () => startProcess(session.pane.id, session.pane.agent, session.pane.task ?? "", plan))',
    )
  })
})
