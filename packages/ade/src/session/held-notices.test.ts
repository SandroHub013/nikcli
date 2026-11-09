import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { codeOf } from "../test-support/source-text"
import { NOTICE_TTL_MS, expiredNotices, gatherNotices, joinNotices } from "./held-notices"

/*
 * ADE's own notices to a session wait for it to be free. On a pane whose box it cannot read that never comes, and when it
 * does they arrived one by one, each a turn the session pays for (audit SES2-4).
 */

const now = 10 * 60 * 60_000
const notice = (paneId: string, text: string, age = 0) => ({ paneId, text, notice: true as const, at: now - age })
const mail = (paneId: string, text: string) => ({ paneId, text })

describe("the notices for one pane", () => {
  test("fourteen for one pane make one line, and the other pane's stay out of it", () => {
    const held = [...Array.from({ length: 14 }, (_, i) => notice("P", `[ade-msg] avviso ${i}`)), notice("Q", "[ade-msg] altro")]
    const line = joinNotices(gatherNotices(held, "P").map((item) => item.text))
    expect(line.startsWith("[ade-msg] 14 avvisi di ADE: avviso 0 | avviso 1")).toBe(true)
    expect(line).toContain("avviso 13")
    expect(line).not.toContain("altro")
    expect(line.match(/\[ade-msg\]/g)).toHaveLength(1)
  })

  test("one goes as it is", () => {
    expect(joinNotices(["[ade-msg] uno"])).toBe("[ade-msg] uno")
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
    expect(joinNotices(["[ade-msg] a\nb", "[ade-msg] c"])).not.toContain("\n")
  })
})

describe("expiry", () => {
  test("past the limit a notice has expired, by pane", () => {
    const held = [notice("P", "vecchio", NOTICE_TTL_MS + 60_000), notice("P", "nuovo", 60_000), notice("Q", "vecchio Q", NOTICE_TTL_MS)]
    const expired = expiredNotices(held, now)
    expect(expired.get("P")!.map((item) => item.text)).toEqual(["vecchio"])
    expect(expired.get("Q")!.map((item) => item.text)).toEqual(["vecchio Q"])
  })

  test("mail never expires here", () => {
    expect(expiredNotices([{ ...mail("P", "ciao"), at: now - NOTICE_TTL_MS * 4 }], now).size).toBe(0)
  })
})

describe("lint: the workbench", () => {
  const source = codeOf(readFileSync(new URL("../surface/workbench.tsx", import.meta.url), "utf8"))

  test("moveMail expires first, then types one line for all of a pane's notices, through the same gate as mail", () => {
    const move = source.slice(source.indexOf(codeOf("const moveMail = async")), source.indexOf(codeOf("const watchMail = async")))
    expect(move.indexOf(codeOf("expiredNotices(heldLines, Date.now())"))).toBeLessThan(move.indexOf(codeOf("for (const item of [...heldLines]) {")))
    expect(move).toContain(codeOf("const notices = gatherNotices(heldLines, item.paneId)"))
    expect(move).toContain(codeOf("typeLineOutcome(session, joinNotices(notices.map((notice) => notice.text)), { mail: false })"))
    expect(move).toContain(codeOf("heldLines.push(...notices)"))
    // Under the free test of every held line, and never past it.
    expect(move.indexOf(codeOf("(await freeNow(host, item.paneId, !item.notice)) && !linesInFlight.has(item.paneId)"))).toBeLessThan(
      move.indexOf(codeOf("const notices = gatherNotices(heldLines, item.paneId)")),
    )
  })

  test("every notice says when it was written", () => {
    expect(source).toContain(codeOf("heldLines.push({ paneId: target.pane, text, notice: true, at: Date.now() })"))
    expect(source).toContain(codeOf("heldLines.push({ paneId: item.inbox.from, text, told: true, notice: true, at: Date.now() })"))
    expect(source).toContain(codeOf("notice: true, at: now, })"))
  })
})
