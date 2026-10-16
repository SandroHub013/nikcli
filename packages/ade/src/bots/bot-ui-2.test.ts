import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { localePreference, setLocalePreference } from "../i18n/locale"
import { EMPTY_BOOK, routineHeadText, routineHeadline, routineName, type Routine, type RoutineBook } from "./routine"
import { forgetBotTraces } from "./forget"
import { memoryAccountStore } from "./account"
import { volatileMemoryStore } from "./memory"
import { memoryRemoteStore } from "./gateway/remote"
import {
  forgetNotice,
  lastNewsAt,
  muteBot,
  noticeOf,
  parseNoticeBook,
  seenUpTo,
  unread,
  type NoticeBook,
} from "./notice"
import { appendMessage, emptyTalk, sendMessage, type Talk } from "./talk"
import { it as itText } from "../i18n/it"
import { en as enText } from "../i18n/en"

/*
 * The second page of choices (design/ade-bot-2, the user's answers of 2026-10-16). What is layout is held as rules on
 * the source, since `bots.tsx` cannot be rendered under `bun test`; what has a rule in it lives in a `.ts` and is
 * tested there.
 */
const read = (file: string) => readFileSync(join(import.meta.dir, file), "utf8")
const tsx = read("bots.tsx")
const css = read("bots.css").replace(/\/\*[\s\S]*?\*\//g, "")

describe("3. the bots' list: every bot a row alike", () => {
  test("no three large ones at the top: each bot is a row, in the order of last use", () => {
    expect(tsx).not.toContain('data-slot="bots-pinned"')
    expect(tsx).not.toContain('data-slot="bots-pin"')
    const list = tsx.slice(tsx.indexOf('<div data-slot="bots-list">'))
    expect(list).toMatch(/^<div data-slot="bots-list">\s*<For each=\{ordered\(\)\}>/)
    // The row keeps the last thing said and when.
    expect(list).toContain("lastLine(talk()")
    expect(list).toContain("formatWhen(talk().updatedAt, now())")
    expect(css).not.toContain('[data-slot="bots-pin')
  })
})

describe("4. the next routine in the bot's head", () => {
  const day = (hour: number, minute = 0, date = 16) => new Date(2026, 9, date, hour, minute).getTime()
  const routine = (id: string, fields: Partial<Routine> = {}): Routine => ({
    id,
    bot: "/p/.claude/agents/posta.md",
    prompt: "Controlla la posta",
    every: { kind: "daily", at: "18:00" },
    consent: "c",
    createdAt: day(8),
    ...fields,
  })
  const book = (routines: Routine[], logs: RoutineBook["logs"] = {}): RoutineBook => ({ ...EMPTY_BOOK, routines, logs })

  test("no routine, no line", () => {
    expect(routineHeadline(EMPTY_BOOK, "/p/.claude/agents/posta.md", day(9))).toBeUndefined()
    const other = book([routine("a", { bot: "/p/.claude/agents/altro.md" })])
    expect(routineHeadline(other, "/p/.claude/agents/posta.md", day(9))).toBeUndefined()
  })

  test("the soonest of the bot's routines, and how many it has", () => {
    const head = routineHeadline(
      book([routine("a"), routine("b", { prompt: "Fai il punto", every: { kind: "daily", at: "12:30" } })]),
      "/p/.claude/agents/posta.md",
      day(9),
    )
    expect(head?.count).toBe(2)
    expect(head?.next?.routine.id).toBe("b")
    expect(head?.next?.at).toBe(day(12, 30))
  })

  test("a paused or suspended routine is counted, never said to be next", () => {
    const head = routineHeadline(
      book([routine("a", { paused: true }), routine("b")], { b: { runs: 0, spentUsd: 0, suspended: "consenso" } }),
      "/p/.claude/agents/posta.md",
      day(9),
    )
    expect(head).toEqual({ count: 2 })
  })

  test("a routine late to run (ADE was closed at its hour) is next now, not at an hour gone by", () => {
    const head = routineHeadline(book([routine("a")]), "/p/.claude/agents/posta.md", day(19))
    expect(head?.next?.at).toBe(day(19))
  })

  test("the line in words: name, when, and how many when more than one", () => {
    const before = localePreference()
    setLocalePreference("it")
    try {
      const one = routineHeadline(book([routine("a")]), "/p/.claude/agents/posta.md", day(9))
      expect(routineHeadText(one!, day(9))).toBe("Prossima routine: «Controlla la posta», oggi alle 18:00")
      const ran = { runs: 1, spentUsd: 0, lastRunAt: day(18) }
      const two = routineHeadline(
        book([routine("a"), routine("b")], { a: ran, b: ran }),
        "/p/.claude/agents/posta.md",
        day(19),
      )
      expect(routineHeadText(two!, day(19))).toBe(
        "Prossima routine: «Controlla la posta», domani alle 18:00 · 2 routine",
      )
      expect(routineHeadText({ count: 2 }, day(9))).toBe("2 routine, tutte in pausa o sospese")
      setLocalePreference("en")
      expect(routineHeadText(one!, day(9))).toBe("Next routine: “Controlla la posta”, today at 06:00 PM")
      expect(routineHeadText(two!, day(19))).toBe(
        "Next routine: “Controlla la posta”, tomorrow at 06:00 PM · 2 routines",
      )
      expect(routineHeadText({ count: 1 }, day(9))).toBe("1 routine, paused or suspended")
    } finally {
      setLocalePreference(before)
    }
  })

  test("a long or many-line prompt is said by its first line, cut", () => {
    expect(routineName("Riassumi le novità\ne poi scrivile")).toBe("Riassumi le novità")
    const long = routineName("a".repeat(80))
    expect(long.length).toBe(40)
    expect(long.endsWith("…")).toBe(true)
  })

  test("the line sits in the head and a click opens the Routines tab", () => {
    const head = tsx.slice(tsx.indexOf("function PageHead("), tsx.indexOf("/** One tab's panel"))
    expect(head).toContain('data-slot="bots-page-routine"')
    expect(head).toContain("onClick={() => props.onRoutines?.()}")
    const page = tsx.slice(tsx.indexOf("function BotPage("))
    expect(page).toContain('tabs().includes("routines")')
    expect(page).toContain('onRoutines: () => select("routines")')
    expect(css).toContain('[data-slot="bots-page-routine"]')
  })
})

describe("6. the «unread» dot and «Silenzia»", () => {
  const bot = "C:/p/.claude/agents/news.md"
  const replied = (at: number): Talk =>
    appendMessage(sendMessage(emptyTalk(), "ciao", at - 10), { role: "bot", text: "Eccomi" }, at)
  const book = (since = 100): NoticeBook => ({ since, bots: {} })

  test("news is the last reply or failure, never the user's own words nor a tool line", () => {
    expect(lastNewsAt(emptyTalk())).toBe(0)
    expect(lastNewsAt(sendMessage(emptyTalk(), "ciao", 500))).toBe(0)
    expect(lastNewsAt(replied(600))).toBe(600)
    const tool = appendMessage(replied(600), { role: "tool", text: "read", tool: "read" }, 700)
    expect(lastNewsAt(tool)).toBe(600)
    expect(lastNewsAt(appendMessage(tool, { role: "error", text: "rete giù" }, 800))).toBe(800)
  })

  test("a reply after the last look is unread; looking at it makes it read", () => {
    expect(unread(book(), bot, replied(600))).toBe(true)
    const looked = seenUpTo(book(), bot, 600)
    expect(unread(looked, bot, replied(600))).toBe(false)
    expect(unread(looked, bot, replied(700))).toBe(true)
    // Looking never goes back in time.
    expect(seenUpTo(looked, bot, 300)).toBe(looked)
  })

  test("what was there before the dot existed is read: no row lights up on the first start", () => {
    expect(unread(book(1000), bot, replied(600))).toBe(false)
  })

  test("a muted bot never has the dot, and unmuted it has it again for what came after the last look", () => {
    const muted = muteBot(book(), bot, true)
    expect(noticeOf(muted, bot).muted).toBe(true)
    expect(unread(muted, bot, replied(600))).toBe(false)
    expect(unread(muteBot(muted, bot, false), bot, replied(600))).toBe(true)
  })

  test("what was saved is read back, and a broken entry is dropped, never half-read", () => {
    const saved = JSON.stringify({ since: 5, bots: { [bot]: { seenAt: 9, muted: true }, x: { seenAt: "no" }, y: 3 } })
    expect(parseNoticeBook(saved, 1)).toEqual({ since: 5, bots: { [bot]: { seenAt: 9, muted: true } } })
    expect(parseNoticeBook("{rotto", 42)).toEqual({ since: 42, bots: {} })
    expect(parseNoticeBook(null, 42)).toEqual({ since: 42, bots: {} })
  })

  test("deleting the bot takes its mute and its last look away", () => {
    let notices = muteBot(seenUpTo(book(), bot, 600), bot, true)
    expect(forgetNotice(notices, bot).bots[bot]).toBeUndefined()
    let routines: RoutineBook = EMPTY_BOOK
    forgetBotTraces(bot, {
      memory: volatileMemoryStore(),
      account: memoryAccountStore(),
      remote: memoryRemoteStore(),
      routines: (change) => (routines = change(routines)),
      notices: (change) => (notices = change(notices)),
    })
    expect(notices.bots[bot]).toBeUndefined()
    expect(read("forget.ts")).toContain("stores.notices?.((book) => forgetNotice(book, path))")
    expect(tsx).toContain("notices: writeNotices,")
  })

  test("the row has the dot and the name in bold while unread; looking at the bot reads it", () => {
    const list = tsx.slice(tsx.indexOf('<div data-slot="bots-list">'))
    expect(list).toContain('data-unread={isUnread() ? "true" : undefined}')
    expect(list).toContain('data-slot="bots-row-unread"')
    expect(css).toMatch(
      /\[data-slot="bots-row"\]\[data-unread="true"\] \[data-slot="bots-row-name"\] \{[^}]*font-weight: var\(--ade-weight-bold\)/,
    )
    expect(css).toContain('[data-slot="bots-row-unread"]')
    // Only the bot's page, shown, is looking at it.
    const main = tsx.slice(tsx.indexOf("export function BotsMain("))
    expect(main).toContain("seenUpTo(book, path, lastNewsAt(talkOf(path)))")
  })

  test("«Silenzia» is in the bot's settings, and says a permission request still comes through", () => {
    const settings = tsx.slice(tsx.indexOf("function SettingsTab("), tsx.indexOf("/* ── the form"))
    expect(settings).toContain('data-slot="bots-mute"')
    expect(settings).toContain("muteBot(book, props.bot.path,")
    for (const text of [itText, enText]) {
      expect(text["bots.notice.mute"].length).toBeGreaterThan(0)
      expect(text["bots.notice.unread"].length).toBeGreaterThan(0)
    }
    expect(itText["bots.notice.muteHint"]).toContain("richiesta di permesso")
    expect(enText["bots.notice.muteHint"]).toContain("permission request")
  })
})
