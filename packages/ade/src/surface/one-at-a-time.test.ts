import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { oneAtATime } from "./one-at-a-time"
import { codeOf } from "../test-support/source-text"

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
    await guard
      .run("p3", async () => {
        throw new Error("spawn")
      })
      .catch(() => undefined)
    expect(guard.busy("p3")).toBe(false)
  })

  test("a run's clock starts with it, and a refused second run does not restart it (review of WB2-2)", async () => {
    let now = 1_000
    const guard = oneAtATime(() => now)
    let finish!: () => void
    const first = guard.run("p", () => new Promise<void>((resolve) => (finish = resolve)))
    expect(guard.startedAt("p")).toBe(1_000)
    now = 5_000
    expect(await guard.run("p", async () => undefined)).toBe(false)
    expect(guard.startedAt("p")).toBe(1_000)
    finish()
    await first
    expect(guard.startedAt("p")).toBeUndefined()
  })

  test("lint: reopen and the restore start a pane through the reopening guard (ALTO 3)", () => {
    const source = readFileSync(join(import.meta.dir, "workbench.tsx"), "utf8")
    const reopen = source.slice(source.indexOf("const reopen = async "), source.indexOf("const reopenPane = async "))
    expect(codeOf(reopen)).toContain(codeOf("reopening.run(given.id, () => reopenPane(given, line, claimed))"))
    expect(codeOf(source)).toContain(
      codeOf(
        'void reopening.run(session.pane.id, () => startProcess(session.pane.id, session.pane.agent, session.pane.task ?? "", plan))',
      ),
    )
  })
})
