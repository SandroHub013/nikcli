import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { codeOf } from "../test-support/source-text"
import { RELAUNCH_MAX_MS, RunningSessions } from "./running"
import { requestState } from "../session/mailbox"
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

  /*
   * Review NB1: a start in its conversation ask when a `relaunch --fresh` began went on, after the newer one had
   * finished, to write the pane's `resumeId`, `linkNonce` and status and clear its records for the live session.
   */
  test("a start superseded during its conversation asks writes nothing of the pane's", () => {
    const body = source.slice(source.indexOf(codeOf("const startProcess = async (")))
    const asks = body.indexOf(codeOf("const minted = await mintConversation("))
    const firstWrite = body.indexOf(codeOf("const paneTitle ="))
    expect(asks).toBeGreaterThan(0)
    expect(body.slice(asks, firstWrite)).toContain(codeOf("if (!running.starting(paneId, start)) return"))
    // And nothing after it touches the pane before the check.
    expect(body.indexOf(codeOf("paneNonces.set(paneId, nonce)"))).toBeGreaterThan(firstWrite)
  })

  test("a spawn becomes the pane's session only through its start", () => {
    expect(source).not.toContain("running.set(")
    expect(source.match(/running\.adopt\(paneId,start,session,refused\)/g)?.length).toBe(2)
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

/*
 * Audit SES-1: `host.spawn` hands back a session object even when the host refused the start (binary not on PATH,
 * key refused, ssh unreachable), already dead and already exited. The workbench used to adopt it all the same, so the
 * pane said «Avvio non riuscito» while `isRunning` was true: no «Riprova», mail «sent» into nothing.
 */
describe("a start the host refused", () => {
  test("is not adopted as the pane's session, so the pane can be retried", () => {
    const kills: Array<{ tree?: boolean } | undefined> = []
    const running = new RunningSessions()
    const token = running.beginStart("a")

    expect(running.adopt("a", token, session(kills), true)).toBe(false)
    expect(running.has("a")).toBe(false)
    expect(running.starting("a", token)).toBe(false)
  })

  test("a start that went through is adopted as before", () => {
    const kills: Array<{ tree?: boolean } | undefined> = []
    const running = new RunningSessions()
    const token = running.beginStart("a")
    const one = session(kills)

    expect(running.adopt("a", token, one, false)).toBe(true)
    expect(running.get("a")).toBe(one)
    expect(kills).toEqual([])
  })

  test("the local start and the ssh start both say whether the host refused", () => {
    const source = codeOf(readFileSync(new URL("./workbench.tsx", import.meta.url), "utf8"))
    expect(source.split(codeOf("running.adopt(paneId, start, session, refused)")).length - 1).toBe(2)
  })
})

/*
 * Live test 2026-11-02, F1: `ade-msg relaunch` on a session with a request open for more than the spawn grace closed
 * the request («si è chiusa senza rispondere») although the relaunch said open requests stay valid.
 */
describe("a pane being relaunched", () => {
  const request = { id: "171-ab", kind: "spawn" as const, from: "n1-0", to: "n2-1", at: 0, brief: "x" }
  const targetOf = (running: RunningSessions) => ({
    running: running.has("n2-1"),
    relaunching: running.relaunching("n2-1"),
    permissionPending: false,
  })

  test("keeps an old open request open, and a failed start closes it with the truth", () => {
    const kills: Array<{ tree?: boolean } | undefined> = []
    const running = new RunningSessions()
    running.set("n2-1", session(kills))
    const tenMinutes = 10 * 60_000
    expect(requestState(request, targetOf(running), tenMinutes)).toBe("in corso")

    // The relaunch's own steps: the mark, then the old process goes.
    const relaunch = running.beginRelaunch("n2-1")
    running.delete("n2-1")
    expect(requestState(request, targetOf(running), tenMinutes)).not.toBe("sessione chiusa")

    // The new process is up: the request is the live one's.
    const start = running.beginStart("n2-1")
    running.adopt("n2-1", start, session(kills))
    running.endRelaunch("n2-1", relaunch)
    expect(requestState(request, targetOf(running), tenMinutes)).toBe("in corso")

    // A relaunch whose start failed: nothing is running, and now the request does close.
    running.delete("n2-1")
    const second = running.beginRelaunch("n2-1")
    expect(requestState(request, targetOf(running), tenMinutes)).not.toBe("sessione chiusa")
    running.endRelaunch("n2-1", second)
    expect(requestState(request, targetOf(running), tenMinutes)).toBe("sessione chiusa")
  })

  test("a later relaunch keeps its mark when an earlier one ends", () => {
    const running = new RunningSessions()
    const first = running.beginRelaunch("a")
    const second = running.beginRelaunch("a")
    running.endRelaunch("a", first)
    expect(running.relaunching("a")).toBe(true)
    running.endRelaunch("a", second)
    expect(running.relaunching("a")).toBe(false)
  })

  /*
   * Review B3: a second relaunch during the first overwrote its token, the second's `reopen` returned at once (one run
   * at a time), its `.finally` lifted the mark, and the first start, still in flight, read as closed.
   */
  test("a second relaunch that ends at once does not lift the mark of the first, still starting", () => {
    const running = new RunningSessions()
    const first = running.beginRelaunch("a")
    const second = running.beginRelaunch("a")
    running.endRelaunch("a", second)
    expect(running.relaunching("a")).toBe(true)
    running.endRelaunch("a", first)
    expect(running.relaunching("a")).toBe(false)
  })

  /*
   * Review B2: nothing on the start's path has a time limit (the keychain, git, another reopen in flight), and before the
   * fix the 30 s grace was the limit. A relaunch that never comes back must close its requests, with the truth.
   */
  test("a relaunch that never ends stops counting after RELAUNCH_MAX_MS, and the request closes", () => {
    const running = new RunningSessions()
    const request = { id: "171-ab", kind: "spawn" as const, from: "n1-0", to: "n2-1", at: 0, brief: "x" }
    running.beginRelaunch("n2-1", 1_000_000)
    const at = (now: number) => requestState(request, { running: false, relaunching: running.relaunching("n2-1", now), permissionPending: false }, now)
    expect(running.relaunching("n2-1", 1_000_000 + RELAUNCH_MAX_MS - 1)).toBe(true)
    expect(at(1_000_000 + RELAUNCH_MAX_MS - 1)).toBe("in avvio")
    expect(running.relaunching("n2-1", 1_000_000 + RELAUNCH_MAX_MS)).toBe(false)
    expect(at(1_000_000 + RELAUNCH_MAX_MS)).toBe("sessione chiusa")
  })

  test("a fresh relaunch after a stale one counts from its own start", () => {
    const running = new RunningSessions()
    running.beginRelaunch("a", 0)
    running.beginRelaunch("a", RELAUNCH_MAX_MS + 10)
    expect(running.relaunching("a", RELAUNCH_MAX_MS + 20)).toBe(true)
  })

  test("closing the pane, or the surface going, ends the mark", () => {
    const running = new RunningSessions()
    running.beginRelaunch("a")
    running.cancelStart("a")
    expect(running.relaunching("a")).toBe(false)
    running.beginRelaunch("b")
    running.endAll()
    expect(running.relaunching("b")).toBe(false)
  })

  test("the workbench marks it before the old process goes, and lifts it when the start is over", () => {
    const source = codeOf(readFileSync(new URL("./workbench.tsx", import.meta.url), "utf8"))
    const branch = source.slice(source.indexOf(codeOf('if (message.kind === "relaunch") {')))
    const body = branch.slice(0, branch.indexOf(codeOf('if (message.kind === "close") {')))
    expect(body.indexOf(codeOf("running.beginRelaunch(pane.id)"))).toBeGreaterThan(0)
    expect(body.indexOf(codeOf("running.beginRelaunch(pane.id)"))).toBeLessThan(body.indexOf(codeOf("running.delete(pane.id)")))
    expect(body).toContain(codeOf("void startProcess(pane.id, agentId, \"\").finally(() => running.endRelaunch(pane.id, relaunch))"))
    expect(body).toContain(codeOf("void reopen(updated).finally(() => running.endRelaunch(pane.id, relaunch))"))
    expect(source).toContain(codeOf("relaunching: running.relaunching(request.to),"))
  })
})

/*
 * Review B4: a message held for a busy pane stayed queued across the parent's relaunch, and on the next pass the pane
 * had no session and was not «waiting for restore»: a held ask was closed with «si è chiusa prima di ricevere la
 * richiesta», a held send was told «non è stato consegnato». The pane was not closed.
 */
describe("mail held for a pane being relaunched", () => {
  const source = codeOf(readFileSync(new URL("./workbench.tsx", import.meta.url), "utf8"))

  test("stays in the queue until the new process is up, before any held message is closed for a missing session", () => {
    const route = source.slice(source.indexOf(codeOf("const session = running.get(target.pane.id)\n    // Read back from the saved queue")))
    const waits = route.indexOf(codeOf("if (!session && running.relaunching(target.pane.id)) {"))
    const closes = route.indexOf(codeOf("if (!session) {"))
    expect(waits).toBeGreaterThan(-1)
    expect(waits).toBeLessThan(closes)
  })

  /*
   * Re-review B8: fresh mail in the gap took the same silent `return false`: no receipt, no `held`. A gap past the client's
   * 10 s and a start that then failed left an ask waiting for ever, and a send told «in coda» and gone.
   */
  test("gets its receipt and is marked held on the first pass, so a failed start tells the truth later", () => {
    const route = source.slice(source.indexOf(codeOf("if (!session && running.relaunching(target.pane.id)) {")))
    const gap = route.slice(0, route.indexOf(codeOf("if (!session) {")))
    expect(gap).toContain(codeOf("if (!held.has(id)) {"))
    expect(gap).toContain(codeOf("held.add(id)"))
    expect(gap).toContain(codeOf("sta ripartendo"))
    expect(gap.indexOf(codeOf("held.add(id)"))).toBeLessThan(gap.indexOf(codeOf("return false")))
  })
})

/*
 * Review B6: a pane holding mail for a half-written line said nothing to the user, and a relaunch left the count of the
 * old process's line behind, so the new one held every message for a line that was gone.
 */
describe("mail held by a line", () => {
  const source = codeOf(readFileSync(new URL("./workbench.tsx", import.meta.url), "utf8"))

  test("the pane tells its user once, and says it again only after the line has gone", () => {
    expect(source).toContain(codeOf("tellPane(target.pane.id, t(\"note.mailHeldByLine\"))"))
    expect(source).toContain(codeOf("if (byLine && !heldByLineNoted.has(target.pane.id)) {"))
    expect(source).toContain(codeOf("heldStates.delete(id)\n    heldByLineNoted.delete(target.pane.id)"))
    expect(source).toContain(codeOf("startRefusals.delete(id)\n    heldByLineNoted.delete(id)"))
  })

  test("a relaunch forgets what was typed into the old process", () => {
    const body = source.slice(source.indexOf(codeOf("running.beginRelaunch(pane.id)")))
    const cut = body.slice(0, body.indexOf(codeOf("void closeSuspendedTree(old)")))
    expect(cut).toContain(codeOf("running.delete(pane.id)\n      // "))
    expect(cut).toContain(codeOf("records.typed.forget(pane.id)"))
  })
})
