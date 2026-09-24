import { describe, expect, test } from "bun:test"
import {
  canSuspend,
  closeSuspendedTree,
  keptWithoutProcess,
  offersSuspend,
  parseSuspendedMail,
  showsSuspendButton,
  stopForSuspend,
  suspendedDelivery,
  suspendedMailToSave,
  type SuspendContext,
  type SuspendPane,
} from "./suspend"

const pane: SuspendPane = { id: "p1", agent: "claude-code", status: "idle", resumeId: "5f0c3a52-0000-4000-8000-000000000001" }
const free: SuspendContext = {
  running: true,
  conversationMissing: false,
  permission: false,
  openRequests: [],
  heldLines: [],
  typing: false,
}

describe("canSuspend (P1-C6)", () => {
  test("a Claude session at rest, with its conversation on disk and nothing under way, can be suspended", () => {
    expect(canSuspend(pane, free)).toEqual({ ok: true })
  })

  test("each condition alone turns the command off, with its own reason", () => {
    const cases: [string, SuspendPane, SuspendContext, string][] = [
      ["another agent", { ...pane, agent: "codex" }, free, "notClaude"],
      ["already suspended", { ...pane, suspended: true }, free, "suspended"],
      ["no process", pane, { ...free, running: false }, "notRunning"],
      ["no resume id", { ...pane, resumeId: undefined }, free, "noConversation"],
      ["conversation not on disk", pane, { ...free, conversationMissing: true }, "noConversation"],
      ["working", { ...pane, status: "working" }, free, "working"],
      ["waiting", { ...pane, status: "waiting" }, free, "working"],
      ["provisioning", { ...pane, status: "provisioning" }, free, "working"],
      ["permission open", pane, { ...free, permission: true }, "permission"],
      ["a request to it", pane, { ...free, openRequests: [{ from: "p2", to: "p1" }] }, "requestTo"],
      ["a request from it", pane, { ...free, openRequests: [{ from: "p1", to: "p2" }] }, "requestFrom"],
      ["a line held for it", pane, { ...free, heldLines: [{ paneId: "p1" }] }, "held"],
      ["the user is typing", pane, { ...free, typing: true }, "typing"],
    ]
    for (const [name, candidate, ctx, reason] of cases) {
      expect({ name, check: canSuspend(candidate, ctx) }).toEqual({ name, check: { ok: false, reason } as never })
    }
  })

  test("other panes' requests and held lines do not count", () => {
    const ctx = { ...free, openRequests: [{ from: "p2", to: "p3" }], heldLines: [{ paneId: "p3" }] }
    expect(canSuspend(pane, ctx)).toEqual({ ok: true })
  })

  test("the command is offered on Claude sessions only", () => {
    expect(offersSuspend(pane)).toBe(true)
    expect(offersSuspend({ agent: "codex" })).toBe(false)
    expect(offersSuspend({})).toBe(false)
    expect(offersSuspend(undefined)).toBe(false)
  })
})

describe("closeSuspendedTree (P1-C6)", () => {
  test("kills the whole tree and waits for the kill to have run", async () => {
    const calls: { tree?: boolean }[] = []
    let finish: (ok: boolean) => void = () => {}
    const session = { kill: (options?: { tree?: boolean }) => (calls.push(options ?? {}), new Promise<boolean>((resolve) => (finish = resolve))) }
    let done = false
    const closing = closeSuspendedTree(session).then((ok) => ((done = true), ok))
    await Promise.resolve()
    expect(calls).toEqual([{ tree: true }])
    expect(done).toBe(false)
    finish(true)
    expect(await closing).toBe(true)
  })

  test("a kill that failed or threw is reported", async () => {
    expect(await closeSuspendedTree({ kill: () => Promise.resolve(false) })).toBe(false)
    expect(
      await closeSuspendedTree({
        kill: () => {
          throw new Error("registro bloccato")
        },
      }),
    ).toBe(false)
  })

  test("a host whose kill returns nothing, or no process at all, counts as closed", async () => {
    expect(await closeSuspendedTree({ kill: () => undefined })).toBe(true)
    expect(await closeSuspendedTree(undefined)).toBe(true)
  })
})

describe("mail for a suspended session (P1-C6)", () => {
  test("send and ask are queued, and the sender is told at once", () => {
    for (const kind of ["send", "ask"]) {
      expect(suspendedDelivery(kind, "A")).toEqual({
        queue: true,
        receipt: 'ok: in coda: la sessione "A" è sospesa; la riceve quando l\'utente la riprende',
      })
    }
  })

  test("restart is refused: nothing wakes a suspended session", () => {
    expect(suspendedDelivery("relaunch", "A")).toEqual({ queue: false, refusal: 'errore: la sessione "A" è sospesa: la riprende l\'utente' })
  })

  test("the other kinds take their usual way", () => {
    for (const kind of ["interrupt", "close", "reply", "update", "spawn"]) expect(suspendedDelivery(kind, "A")).toBeUndefined()
  })

  test("the saved queue is read back after a restart, in the order it came", () => {
    const held = [
      { paneId: "a", text: "uno", inbox: { id: "1", kind: "send" as const, from: "m" }, suspended: true as const },
      { paneId: "b", text: "di un'altra", suspended: true as const },
      { paneId: "a", text: "due", full: "due\nrighe", inbox: { id: "2", kind: "ask" as const, from: "m" }, suspended: true as const },
      { paneId: "a", text: "non sospesa" },
    ]
    const saved = JSON.stringify(suspendedMailToSave(held, (id) => id === "a"))
    expect(parseSuspendedMail(saved)).toEqual([held[0]!, held[2]!])
  })

  test("a malformed saved queue is dropped entry by entry", () => {
    expect(parseSuspendedMail(null)).toEqual([])
    expect(parseSuspendedMail("{rotto")).toEqual([])
    expect(parseSuspendedMail('{"paneId":"a"}')).toEqual([])
    const text = JSON.stringify([
      { paneId: "a", text: "buona" },
      { paneId: "", text: "senza pannello" },
      { paneId: "a", text: 3 },
      { paneId: "a", text: "tipo sconosciuto", inbox: { id: "1", kind: "spawn", from: "m" } },
      null,
    ])
    expect(parseSuspendedMail(text)).toEqual([{ paneId: "a", text: "buona", suspended: true }])
  })
})

describe("stopForSuspend: a kill that fails is not a suspension", () => {
  const fake = (result: boolean) => ({ kill: async () => result })

  test("closed: out of running", async () => {
    const running = new Map([["p1", fake(true)]])
    let changes = 0
    expect(await stopForSuspend("p1", running, () => changes++)).toBe(true)
    expect(running.has("p1")).toBe(false)
    expect(changes).toBe(1)
  })

  test("failed: back in running, so Riprendi cannot open a second process on the same conversation", async () => {
    const session = fake(false)
    const running = new Map([["p1", session]])
    expect(await stopForSuspend("p1", running, () => {})).toBe(false)
    expect(running.get("p1")).toBe(session)
  })
})

describe("the Sospendi button", () => {
  test("hidden on a pane already suspended, shown (maybe off) otherwise", () => {
    expect(showsSuspendButton({ ok: false, reason: "suspended" })).toBe(false)
    expect(showsSuspendButton(undefined)).toBe(false)
    expect(showsSuspendButton({ ok: true })).toBe(true)
    expect(showsSuspendButton({ ok: false, reason: "working" })).toBe(true)
  })
})

describe("the queue after Riprendi (Fabio, BASSO 2)", () => {
  test("still saved until typed: ADE closing right after Riprendi loses nothing", () => {
    const held = [{ paneId: "a", text: "uno", inbox: { id: "1", kind: "send" as const, from: "m" }, suspended: true as const }]
    // The pane is no longer suspended, but its mail is not typed yet.
    const saved = suspendedMailToSave(held, (id) => id === "a")
    expect(parseSuspendedMail(JSON.stringify(saved))).toEqual(held)
    // Its pane closed: nobody left to read it.
    expect(suspendedMailToSave(held, () => false)).toEqual([])
  })

  test("kept while the resumed session has no process yet, dropped once its pane is gone", () => {
    const queued = { suspended: true as const }
    expect(keptWithoutProcess(queued, { exists: true, suspended: false })).toBe(true)
    expect(keptWithoutProcess(queued, { exists: false, suspended: false })).toBe(false)
    expect(keptWithoutProcess({}, { exists: true, suspended: true })).toBe(true)
    // Other held lines for a session without process go, as before.
    expect(keptWithoutProcess({}, { exists: true, suspended: false })).toBe(false)
  })
})
