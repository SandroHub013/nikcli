import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { RELAUNCH_MAX_MS } from "../surface/running"
import { QUEUE_MAX_AGE_MS, RESTORE_GRACE_MS, parseQueue, queueToSave, waitsForRestore, waitsForStart, type QueuedMessage } from "./mail-queue"
import { suspendedMailToSave } from "./suspend"
import { codeOf } from "../test-support/source-text"
import type { Message } from "./mailbox"
import { workbenchSource } from "../test-support/workbench-source"

/*
 * `ade-msg send` answers «ok: in coda» the moment a message is held for a busy session, and its sender stops
 * listening. The message itself was taken out of the outbox and lived only in ADE's memory, so a restart (or a
 * crash) lost it with nobody told: the 17:43 message to «Sol 6.1 sandrobench» on 2026-10-14.
 */

const send = (to: string, text = "ciao"): Message => ({ kind: "send", from: "p1", to, text })
const ask = (to: string): Message => ({ kind: "ask", from: "p1", to, text: "fai", budget: 600 })
const NOW = 1_800_000_000_000

describe("the queue of messages held for a busy session survives a restart", () => {
  test("what was held is saved and read back in the same order", () => {
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
  const source = workbenchSource()

  test("written before any delivery starts and again when one ends, and nothing before it was read back", () => {
    // WB-6: the take deleted it from the outbox, so a crash during a long `close` must not lose what was told «in coda».
    const taken = source.indexOf("mailQueue.push(...arrived)")
    const written = source.indexOf("persistMail()", taken)
    const started = source.indexOf("mailLanes.start(mailQueue)", taken)
    expect(taken).toBeGreaterThan(0)
    expect(written).toBeGreaterThan(taken)
    expect(started).toBeGreaterThan(written)
    const done = source.indexOf("done: (item) => {")
    expect(done).toBeGreaterThan(0)
    expect(source.indexOf("persistMail()", done)).toBeLessThan(source.indexOf("hung: (item, afterMs)", done))
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

describe("a message is confirmed only once the page has it on disk (RS2-5 B)", () => {
  const source = workbenchSource()
  const take = source.slice(source.indexOf("const takeMail = async ("), source.indexOf("const moveMail = async ("))

  test("no take before the saved queue has been read back: a confirm then would lose what cannot be written yet", () => {
    const gate = take.indexOf("if (!mailRestored) return")
    expect(gate).toBeGreaterThan(-1)
    expect(gate).toBeLessThan(take.indexOf("mailboxTake"))
  })

  test("every id taken is confirmed, only after a save that worked, and before any delivery starts", () => {
    const saved = take.indexOf("idsToConfirm(persistMail(), taken, settled)")
    const confirmed = take.indexOf("host.mailboxTaken?.(confirmed)")
    const started = take.indexOf("mailLanes.start(mailQueue)")
    expect(saved).toBeGreaterThan(-1)
    expect(confirmed).toBeGreaterThan(saved)
    expect(started).toBeGreaterThan(confirmed)
  })

  test("persistMail says whether it wrote", () => {
    expect(source).toContain("return mailWriter.save(now, () => writeStored(QUEUE_KEY, queue) && saveSuspendedMail())")
    expect(source).toContain("const persistMail = (): boolean => {")
  })

  test("a copy goes before anything is done with it, and what the saved queue held counts as taken", () => {
    const copy = take.indexOf("takenMail.sort(taken, waitingHere)")
    expect(copy).toBeGreaterThan(-1)
    expect(copy).toBeLessThan(take.indexOf("splitSealed(body)"))
    expect(source).toContain("takenMail.restored(item.id)")
  })

  test("a delivery that ended confirms its id too: with storage refusing, no save ever will", () => {
    const done = source.indexOf("done: (item) => {")
    expect(source.indexOf("confirmTaken(item.id)", done)).toBeGreaterThan(done)
    expect(source.indexOf("confirmTaken(item.id)", done)).toBeLessThan(source.indexOf("hung: (item, afterMs)", done))
    expect(source.slice(done)).toContain("if (mayConfirmEnded(persistMail(), waitingHere(item.id))) confirmTaken(item.id)")
  })

  test("the messages of one take join the queue together, after the last proof: a round cannot type the first before the save", () => {
    const joined = take.indexOf("mailQueue.push(...arrived)")
    expect(take).toContain("if (message) arrived.push({ id, message, at: Date.now() })")
    expect(joined).toBeGreaterThan(take.lastIndexOf("await sealedBy("))
    expect(joined).toBeLessThan(take.indexOf("idsToConfirm(persistMail(), taken, settled)"))
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

/*
 * Source checks for the wiring of the audit's data-safety fixes (review of ade/dati-salvi): the pure parts have
 * their own tests; these pin that the workbench actually uses them, in the order that matters.
 */
describe("the data-safety wiring in the workbench", () => {
  const source = workbenchSource()
  test("the update persists the mail and the mail round waits for the install", () => {
    const run = source.indexOf("const runUpdate = async () => {")
    const flush = source.indexOf("autosave.flush()", run)
    const persisted = source.indexOf("persistMail()", flush)
    const install = source.indexOf('invoke("ade_update_install")', run)
    expect(persisted).toBeGreaterThan(flush)
    expect(install).toBeGreaterThan(persisted)
    // One pause for the timer and the native signal alike (`createMailRound`), not a line in the timer only.
    expect(source).toContain("paused: () => installingUpdate(),")
  })

  test("the reload prompt does not come after a restore, and a restore refuses an unsaved file first", () => {
    const leaving = source.indexOf("const handleBeforeUnload = (event: BeforeUnloadEvent) => {")
    expect(source.indexOf("if (closingConfirmed || workspaceRestoring) return", leaving)).toBeGreaterThan(leaving)
    const restore = source.indexOf("const restoreSessions = (copyKey: string) => {")
    const dirty = source.indexOf("buffer.dirty", restore)
    const written = source.indexOf("restoreCopy(localStorage, copyKey)", restore)
    expect(dirty).toBeGreaterThan(restore)
    expect(written).toBeGreaterThan(dirty)
    expect(source.slice(dirty, written)).toContain('report(t("workspace.restore.saveFirst"))')
  })

  test("the question says running agents stop, in both languages", () => {
    const text = readFileSync(new URL("../i18n/en.ts", import.meta.url), "utf8") + readFileSync(new URL("../i18n/it.ts", import.meta.url), "utf8")
    expect(text).toContain("running agents stop")
    expect(text).toContain("gli agenti in corso si fermano")
  })

  test("the autosave never throws, never writes over a restore, and respects the block", () => {
    const write = source.indexOf("write: () => {\n      if (workspaceRestoring) return")
    expect(write).toBeGreaterThan(0)
    const block = source.indexOf("if (workspaceSaveBlocked) {", write)
    const save = source.indexOf('localStorage.setItem("ade.workspace"', write)
    const caught = source.indexOf("} catch {", save)
    expect(block).toBeGreaterThan(write)
    expect(save).toBeGreaterThan(block)
    expect(caught).toBeGreaterThan(save)
    expect(source).toContain("retryUnreadableCopy(localStorage, Date.now())")
  })
})

describe("mail for a session on its way back (audit WB2-2)", () => {
  const input = { paneExists: true, reopening: false, plannedAtBoot: false, sinceBoot: 1_000, sinceStart: 0 }

  test("«Riprendi» under way: it waits, where it used to be refused as not active", () => {
    expect(waitsForStart({ ...input, reopening: true })).toBe(true)
  })

  test("planned at boot and not started yet: it waits", () => {
    expect(waitsForStart({ ...input, plannedAtBoot: true })).toBe(true)
  })

  test("a plan that never starts is cut off by the grace", () => {
    expect(waitsForStart({ ...input, plannedAtBoot: true, sinceBoot: RESTORE_GRACE_MS })).toBe(false)
  })

  test("a start under way counts from when it began, not from the boot", () => {
    expect(waitsForStart({ ...input, reopening: true, sinceBoot: RESTORE_GRACE_MS * 2, sinceStart: RELAUNCH_MAX_MS - 1 })).toBe(true)
  })

  test("a start under way past RELAUNCH_MAX_MS is refused: nothing on its path has a limit of its own", () => {
    expect(waitsForStart({ ...input, reopening: true, sinceStart: RELAUNCH_MAX_MS })).toBe(false)
  })

  test("a pane the user has closed is refused, as before", () => {
    expect(waitsForStart({ ...input, paneExists: false, reopening: true, plannedAtBoot: true })).toBe(false)
  })

  test("nothing on its way: refused, as before", () => {
    expect(waitsForStart(input)).toBe(false)
  })

  test("lint: deliverOne asks about the start, with the receipt of a relaunch, and the boot says what it plans", () => {
    const source = codeOf(workbenchSource())
    expect(source).toContain(
      codeOf("if (!session && (running.relaunching(target.pane.id) || waitsForStart({ paneExists: paneExists(target.pane.id), reopening: reopening.busy(target.pane.id), sinceStart: Date.now() - (reopening.startedAt(target.pane.id) ?? Date.now()), plannedAtBoot: restorePlanned.has(target.pane.id), sinceBoot: Date.now() - loadedAt }))) {"),
    )
    expect(source).toContain(codeOf("for (const pane of sessionsToResume(state)) restorePlanned.add(pane.id)"))
    expect(source).toContain(codeOf("for (const pane of liveToReopen(wb().panes, restorePlanned, state)) restorePlanned.add(pane.id)"))
    expect(source).toContain(codeOf(".finally(() => restorePlanned.delete(session.pane.id))"))
    expect(source).toContain(codeOf(".finally(() => restorePlanned.delete(pane.id))"))
    expect(source).toContain(codeOf("} else restorePlanned.clear()"))
  })
})
