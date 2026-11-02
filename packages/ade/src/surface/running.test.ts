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
 * Audit 2026-11-02, SES-2: ADE restores six sessions, the user closes one in
 * the first second. Its start was still awaiting git, the keys and the spawn,
 * so the close found nothing to kill; the process came up with no pane, out of
 * `ade-msg list`, and the opening poll typed the task into it.
 */
describe("a pane closed or started again while its process starts", () => {
  test("closed: the process that comes back is ended with its tree, never adopted", () => {
    const kills: Array<{ tree?: boolean } | undefined> = []
    const running = new RunningSessions()
    const start = running.beginStart("p1")
    running.cancelStart("p1")

    expect(running.starting("p1", start)).toBe(false)
    expect(running.adopt("p1", start, session(kills))).toBe(false)
    expect(kills).toEqual([{ tree: true }])
    expect(running.has("p1")).toBe(false)
  })

  test("started again: the first start's process goes, the second one's is the pane's", () => {
    const kills: Array<{ tree?: boolean } | undefined> = []
    const running = new RunningSessions()
    const first = running.beginStart("p1")
    const second = running.beginStart("p1")
    const kept = session([])

    expect(running.adopt("p1", second, kept)).toBe(true)
    expect(running.adopt("p1", first, session(kills))).toBe(false)
    expect(kills).toEqual([{ tree: true }])
    expect(running.get("p1")).toBe(kept)
  })

  test("left alone, the start adopts its process", () => {
    const running = new RunningSessions()
    const start = running.beginStart("p1")
    const one = session([])
    expect(running.starting("p1", start)).toBe(true)
    expect(running.adopt("p1", start, one)).toBe(true)
    expect(running.get("p1")).toBe(one)
    // Adopted once: the token is spent.
    expect(running.starting("p1", start)).toBe(false)
  })

  test("after the surface went, nothing is adopted", () => {
    const kills: Array<{ tree?: boolean } | undefined> = []
    const running = new RunningSessions()
    const start = running.beginStart("p1")
    running.endAll()
    expect(running.adopt("p1", start, session(kills))).toBe(false)
    expect(kills).toEqual([{ tree: true }])
  })
})

describe("the workbench's starts", () => {
  const source = codeOf(readFileSync(new URL("./workbench.tsx", import.meta.url), "utf8"))

  test("take their token before the first await, and closing a pane takes it away", () => {
    const body = source.slice(source.indexOf(codeOf("const startProcess = async (")))
    const beforeAwait = body.slice(0, body.indexOf("await"))
    expect(beforeAwait).toContain(codeOf("const start = running.beginStart(paneId)"))
    const closeNow = source.slice(source.indexOf(codeOf("const closeNow = (id: string) => {")))
    expect(closeNow.slice(0, closeNow.indexOf("disposeTerminal"))).toContain(codeOf("running.cancelStart(id)"))
  })

  test("a spawn becomes the pane's session only through its start", () => {
    expect(source).not.toContain("running.set(")
    expect(source.match(/running\.adopt\(paneId,start,session\)/g)?.length).toBe(2)
  })

  /*
   * SES-4: a relaunch in the first seconds put a new session in the pane, and
   * the old poll, checking only that the pane had one, typed the old task into
   * it (twice, or into a `--fresh` start meant to drop it).
   */
  test("the opening task's poll stops when its session is no longer the pane's, and types into its own", () => {
    const poll = source.slice(source.indexOf(codeOf("if (starting.typesTask) {")))
    const tick = poll.slice(0, poll.indexOf("openingPolls.add(poll)"))
    expect(tick).toContain(codeOf("if (running.get(paneId) !== session) { stopOpeningPoll(poll)"))
    expect(tick).not.toContain("running.has(paneId)")
    expect(tick).not.toContain(codeOf("const session = running.get(paneId)"))
  })
})

/*
 * Measured in ADE Test: every hot update of `workbench.tsx` mounted a new
 * Workbench in the same page, which restored its three agents by spawning
 * them again while the old three ran on (ragu at 580 MB), until ADE closed.
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
