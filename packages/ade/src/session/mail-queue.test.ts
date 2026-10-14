import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { QUEUE_MAX_AGE_MS, RESTORE_GRACE_MS, parseQueue, queueToSave, waitsForRestore, type QueuedMessage } from "./mail-queue"
import { suspendedMailToSave } from "./suspend"
import type { Message } from "./mailbox"

/*
 * `ade-msg send` answers «ok: in coda» the moment a message is held for a busy session, and its sender stops
 * listening. The message itself was taken out of the outbox and lived only in ADE's memory, so a restart (or a
 * crash) lost it with nobody told: the 17:43 message to «Sol 6.1 sandrobench» on 2026-10-14.
 */

const send = (to: string, text = "ciao"): Message => ({ kind: "send", from: "p1", token: "segreto", to, text })
const ask = (to: string): Message => ({ kind: "ask", from: "p1", token: "segreto", to, text: "fai", budget: 600 })
const NOW = 1_800_000_000_000

describe("the queue of messages held for a busy session survives a restart", () => {
  test("what was held is saved and read back in the same order, without the sender's token", () => {
    const queue: QueuedMessage[] = [
      { id: "r1", message: send("p2"), at: NOW - 5_000 },
      { id: "r2", message: ask("p3"), at: NOW - 1_000 },
    ]
    const { live, expired } = parseQueue(queueToSave(queue), NOW)
    expect(expired).toEqual([])
    expect(live.map((item) => item.id)).toEqual(["r1", "r2"])
    expect(live[0]!.message).toMatchObject({ kind: "send", from: "p1", to: "p2", text: "ciao" })
    expect(live[1]!.message).toMatchObject({ kind: "ask", to: "p3", budget: 600 })
    // The token proved the sender once, in the process that received it: it is not kept on disk.
    expect(queueToSave(queue)).not.toContain("segreto")
    expect(live.every((item) => (item.message as { token?: string }).token === undefined)).toBe(true)
  })

  test("only send and ask are kept: the other kinds are answered at once and are not mail", () => {
    const queue: QueuedMessage[] = [
      { id: "r1", message: { kind: "interrupt", from: "p1", to: "p2", text: "" }, at: NOW },
      { id: "r2", message: send("p2"), at: NOW },
    ]
    expect(parseQueue(queueToSave(queue), NOW).live.map((item) => item.id)).toEqual(["r2"])
  })

  test("a message older than the limit is handed back as expired, so its sender can be told", () => {
    const queue: QueuedMessage[] = [
      { id: "old", message: send("p2"), at: NOW - QUEUE_MAX_AGE_MS - 1 },
      { id: "new", message: send("p2"), at: NOW - 1 },
    ]
    const { live, expired } = parseQueue(queueToSave(queue), NOW)
    expect(live.map((item) => item.id)).toEqual(["new"])
    expect(expired.map((item) => item.id)).toEqual(["old"])
  })

  test("a malformed saved queue is dropped entry by entry", () => {
    expect(parseQueue(null, NOW)).toEqual({ live: [], expired: [] })
    expect(parseQueue("{rotto", NOW)).toEqual({ live: [], expired: [] })
    expect(parseQueue('{"id":"a"}', NOW)).toEqual({ live: [], expired: [] })
    const text = JSON.stringify([
      { id: "ok", at: NOW, message: { kind: "send", from: "p1", to: "p2", text: "buona" } },
      { id: "bad id!", at: NOW, message: { kind: "send", from: "p1", to: "p2", text: "x" } },
      { id: "no-to", at: NOW, message: { kind: "send", from: "p1", text: "x" } },
      { id: "no-text", at: NOW, message: { kind: "ask", from: "p1", to: "p2" } },
      { id: "no-at", message: { kind: "send", from: "p1", to: "p2", text: "x" } },
      null,
    ])
    expect(parseQueue(text, NOW).live.map((item) => item.id)).toEqual(["ok"])
  })
})

describe("a replayed message waits for its pane's process instead of being dropped as «closed»", () => {
  // Found live on 2026-10-14: the queue came back after the restart, and the first pass ran before the restored
  // sessions had been started again. The pane existed, its process did not yet, and the message was dropped.
  test("waits while the pane exists without a process, shortly after the start", () => {
    expect(waitsForRestore({ replayed: true, paneExists: true, sinceBoot: 5_000 })).toBe(true)
    expect(waitsForRestore({ replayed: true, paneExists: true, sinceBoot: RESTORE_GRACE_MS - 1 })).toBe(true)
  })

  test("not for a fresh message, a pane that is gone, or once the grace has run out", () => {
    expect(waitsForRestore({ replayed: false, paneExists: true, sinceBoot: 5_000 })).toBe(false)
    expect(waitsForRestore({ replayed: true, paneExists: false, sinceBoot: 5_000 })).toBe(false)
    expect(waitsForRestore({ replayed: true, paneExists: true, sinceBoot: RESTORE_GRACE_MS })).toBe(false)
  })
})

describe("lint: the workbench writes the queue and reads it back", () => {
  const source = readFileSync(new URL("../surface/workbench.tsx", import.meta.url), "utf8")

  test("written at the end of the pass that delivers it, and nothing before it was read back", () => {
    const delivered = source.indexOf("const done = await deliverOne(host, item.id, item.message)")
    const written = source.indexOf("persistMail()", delivered)
    expect(delivered).toBeGreaterThan(0)
    expect(written).toBeGreaterThan(delivered)
    expect(source).toContain("if (!mailRestored) return")
  })

  test("read back once the saved layout is, and a held message's sender is told when its session is gone", () => {
    const layout = source.indexOf("setWb(fromWorkspaceState(state))")
    const restored = source.indexOf("await restoreMail(host)", layout)
    expect(layout).toBeGreaterThan(0)
    expect(restored).toBeGreaterThan(layout)
    expect(source).toContain("è stato consegnato`")
    expect(source).toContain("si è chiusa prima di ricevere il messaggio")
  })
})

describe("the lines held for a running session are saved too, not only those of a suspended one", () => {
  test("a held ask or send for a pane that exists is saved; a notice or a closed pane's mail is not", () => {
    const held = [
      { paneId: "a", text: "richiesta", inbox: { id: "r1", kind: "ask", from: "m" } },
      { paneId: "a", text: "nota", inbox: { id: "r2", kind: "send", from: "m" } },
      { paneId: "a", text: "avviso senza posta" },
      { paneId: "a", text: "risposta", inbox: { id: "r3", kind: "reply", from: "m" } },
      { paneId: "gone", text: "per un pannello chiuso", inbox: { id: "r4", kind: "send", from: "m" } },
    ]
    expect(suspendedMailToSave(held, (id) => id === "a").map((line) => line.inbox?.id)).toEqual(["r1", "r2"])
  })
})
