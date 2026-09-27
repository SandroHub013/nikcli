import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { codeOf } from "../test-support/source-text"
import { RunningSessions } from "./running"
import type { SpawnedSession } from "../host/shell"

function session(kills: Array<{ tree?: boolean } | undefined>): SpawnedSession {
  return { kill: (options) => void kills.push(options), write: () => {}, resize: () => {} }
}

describe("the sessions a surface owns", () => {
  test("go with the surface, each with the processes it started", () => {
    const kills: Array<{ tree?: boolean } | undefined> = []
    const running = new RunningSessions()
    running.set("a", session(kills))
    running.set("b", session(kills))

    expect(running.endAll()).toBe(2)
    expect(kills).toEqual([{ tree: true }, { tree: true }])
    expect(running.size).toBe(0)
  })

  test("a spawn that comes back after the surface went is ended, not held", () => {
    const kills: Array<{ tree?: boolean } | undefined> = []
    const running = new RunningSessions()
    running.endAll()

    running.set("late", session(kills))
    expect(kills).toEqual([{ tree: true }])
    expect(running.has("late")).toBe(false)
  })

  test("before that, it is the map the workbench always used", () => {
    const kills: Array<{ tree?: boolean } | undefined> = []
    const running = new RunningSessions()
    const one = session(kills)
    running.set("a", one)
    expect(running.get("a")).toBe(one)
    running.delete("a")
    expect(running.size).toBe(0)
    expect(kills).toEqual([])
  })
})

/*
 * Measured in ADE Test: every hot update of `workbench.tsx` mounted a new
 * Workbench in the same page, which restored its three agents by spawning
 * them again while the old three ran on (nikcli at 580 MB), until ADE closed.
 * The cleanup has to be registered during setup: after an await Solid has no
 * owner and `onCleanup` is a silent no-op.
 */
describe("the workbench", () => {
  const source = codeOf(readFileSync(new URL("./workbench.tsx", import.meta.url), "utf8"))

  /*
   * Right after the map is made, which is in the component's own body: an
   * `onCleanup` placed after an await, or inside a handler, would never run.
   */
  test("ends its sessions when it is disposed, registered as the map is made", () => {
    expect(source).toContain(codeOf("const running = new RunningSessions() onCleanup(() => running.endAll())"))
  })
})
