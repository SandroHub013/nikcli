import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { codeOf } from "../test-support/source-text"
import { MOST_JOINED, NOTICE_TTL_MS, expiredNotices, gatherNotices, joinNotices } from "./held-notices"
import { blindNow } from "./deliver-now"
import { workbenchSource } from "../test-support/workbench-source"

/*
 * ADE's own notices to a session wait for it to be free. On a pane whose box it cannot read that never comes, and when it
 * does they arrived one by one, each a turn the session pays for (audit SES2-4).
 */

const now = 10 * 60 * 60_000
const notice = (paneId: string, text: string, age = 0) => ({ paneId, text, notice: true as const, at: now - age })
const mail = (paneId: string, text: string) => ({ paneId, text })
const lines = (...texts: string[]) => texts.map((text) => ({ text }))

describe("the notices for one pane", () => {
  test("fourteen for one pane make one line, and the other pane's stay out of it", () => {
    const held = [...Array.from({ length: 14 }, (_, i) => notice("P", `[ade-msg] avviso ${i}`)), notice("Q", "[ade-msg] altro")]
    const line = joinNotices(gatherNotices(held, "P"))
    expect(line.startsWith("[ade-msg] 14 avvisi di ADE: avviso 6 | avviso 7")).toBe(true)
    expect(line).toContain("avviso 13")
    expect(line).not.toContain("avviso 5")
    expect(line.endsWith(" | e altri 6 più vecchi")).toBe(true)
    expect(line).not.toContain("altro")
    expect(line.match(/\[ade-msg\]/g)).toHaveLength(1)
  })

  test("a few fit whole", () => {
    expect(joinNotices(lines("[ade-msg] a", "[ade-msg] b"))).toBe("[ade-msg] 2 avvisi di ADE: a | b")
  })

  test("an error is never left out of the line: it says a message did not arrive", () => {
    const texts = ["[ade-msg] errore: X non è stato consegnato", ...Array.from({ length: 10 }, (_, i) => `[ade-msg] avviso ${i}`)]
    const line = joinNotices(lines(...texts))
    expect(line).toContain("errore: X non è stato consegnato")
    expect(line).toContain("avviso 9")
    expect(line).not.toContain("avviso 2 ")
    expect(line.split(" | ")).toHaveLength(MOST_JOINED + 1)
    expect(line.endsWith(" | e altri 3 più vecchi")).toBe(true)
  })

  test("a notice marked as a loss is never left out of the line, whatever it says", () => {
    const line = joinNotices([
      { text: "[ade-msg] La richiesta r1 non è stata digitata", lost: true as const },
      ...lines(...Array.from({ length: 10 }, (_, i) => `[ade-msg] avviso ${i}`)),
    ])
    expect(line).toContain("La richiesta r1 non è stata digitata")
    expect(line.split(" | ")).toHaveLength(MOST_JOINED + 1)
    expect(line.endsWith(" | e altri 3 più vecchi")).toBe(true)
  })

  test("one goes as it is", () => {
    expect(joinNotices(lines("[ade-msg] uno"))).toBe("[ade-msg] uno")
  })

  test("a notice is never a message: mail is not gathered", () => {
    const held = [notice("P", "[ade-msg] a"), mail("P", "[Messaggio da X]: ciao")]
    expect(gatherNotices(held, "P").map((item) => item.text)).toEqual(["[ade-msg] a"])
  })

  test("oldest first, whatever the order they went back in the queue", () => {
    const held = [notice("P", "dopo", 1_000), notice("P", "prima", 5_000)]
    expect(gatherNotices(held, "P").map((item) => item.text)).toEqual(["prima", "dopo"])
  })

  test("a row of its own for each is kept to one line: a newline in a notice would be an Enter", () => {
    expect(joinNotices(lines("[ade-msg] a\nb", "[ade-msg] c"))).not.toContain("\n")
  })
})

describe("expiry", () => {
  test("past the limit a notice has expired, by pane", () => {
    const held = [notice("P", "vecchio", NOTICE_TTL_MS + 60_000), notice("P", "nuovo", 60_000), notice("Q", "vecchio Q", NOTICE_TTL_MS)]
    const expired = expiredNotices(held, now, () => true)
    expect(expired.get("P")!.map((item) => item.text)).toEqual(["vecchio"])
    expect(expired.get("Q")!.map((item) => item.text)).toEqual(["vecchio Q"])
  })

  test("mail never expires here", () => {
    expect(expiredNotices([{ ...mail("P", "ciao"), at: now - NOTICE_TTL_MS * 4 }], now, () => true).size).toBe(0)
  })

  const old = NOTICE_TTL_MS + 60_000

  test("behind a known turn or a menu a notice waits as long as they do, and goes when the pane is free", () => {
    const held = [notice("P", "[ade-msg] dopo il turno", old)]
    const inTurn = blindNow({ box: "none", question: false, turn: true, nothingDrawn: false })
    const behindMenu = blindNow({ box: "none", question: true, turn: false, nothingDrawn: false })
    expect(expiredNotices(held, now, () => inTurn).size).toBe(0)
    expect(expiredNotices(held, now, () => behindMenu).size).toBe(0)
    expect(gatherNotices(held, "P").map((item) => item.text)).toEqual(["[ade-msg] dopo il turno"])
  })

  test("only the pane ADE cannot read loses them", () => {
    const held = [notice("P", "[ade-msg] a", old), notice("Q", "[ade-msg] b", old)]
    expect([...expiredNotices(held, now, (paneId) => paneId === "Q").keys()]).toEqual(["Q"])
  })

  test("a notice marked as a loss never expires either", () => {
    const held = [{ ...notice("P", "[ade-msg] Il messaggio r1 non è partito", NOTICE_TTL_MS * 10), lost: true as const }]
    expect(expiredNotices(held, now, () => true).size).toBe(0)
  })

  test("an error never expires, not even on a box ADE cannot read", () => {
    const held = [notice("P", "[ade-msg] errore: la sessione X si è chiusa: non è stato consegnato", NOTICE_TTL_MS * 10)]
    expect(expiredNotices(held, now, () => true).size).toBe(0)
  })
})

describe("lint: the workbench", () => {
  const source = codeOf(workbenchSource())

  test("the three notices that tell of a loss in words of their own are marked where they are queued", () => {
    expect(source).toContain(codeOf("tellSender(sender.from, formatEnterLost(sender.id, mailPanes().find((pane) => pane.id === paneId)), { lost: true })"))
    expect(source).toContain(codeOf("tellSender(meta.from, formatEnterStuck(meta.id, mailPanes().find((pane) => pane.id === paneId)), { lost: true })"))
    expect(source).toContain(codeOf("tellSender(asked.from, formatExitedUnsent(asked.id, reader, trustSeen), { lost: true })"))
  })

  test("moveMail expires first, then types one line for all of a pane's notices, through the same gate as mail", () => {
    const move = source.slice(source.indexOf(codeOf("const moveMail = async")), source.indexOf(codeOf("const watchMail = async")))
    expect(move.indexOf(codeOf("expiredNotices(heldLines, Date.now(), (paneId) => running.has(paneId) && blindHold(paneId).blind)"))).toBeGreaterThan(-1)
    expect(move.indexOf(codeOf("expiredNotices(heldLines, Date.now(), (paneId) => running.has(paneId) && blindHold(paneId).blind)"))).toBeLessThan(move.indexOf(codeOf("for (const item of [...heldLines]) {")))
    expect(move).toContain(codeOf("const notices = gatherNotices(heldLines, item.paneId)"))
    expect(move).toContain(codeOf("typeLineOutcome(session, joinNotices(notices), { mail: false })"))
    expect(move).toContain(codeOf("heldLines.push(...notices)"))
    // Under the free test of every held line, and never past it.
    expect(move.indexOf(codeOf("(await freeNow(host, item.paneId, !item.notice)) && !linesInFlight.has(item.paneId)"))).toBeLessThan(
      move.indexOf(codeOf("const notices = gatherNotices(heldLines, item.paneId)")),
    )
  })

  test("every notice says when it was written", () => {
    expect(source).toContain(codeOf("heldLines.push({ paneId: target.pane, text, notice: true, at: Date.now(), ...mark })"))
    expect(source).toContain(codeOf("heldLines.push({ paneId: item.inbox.from, text, told: true, notice: true, at: Date.now() })"))
    expect(source).toContain(codeOf("notice: true, at: now, })"))
  })
})
