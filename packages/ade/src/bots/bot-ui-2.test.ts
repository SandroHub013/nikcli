import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { localePreference, setLocalePreference } from "../i18n/locale"
import { EMPTY_BOOK, routineHeadText, routineHeadline, routineName, type Routine, type RoutineBook } from "./routine"

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
