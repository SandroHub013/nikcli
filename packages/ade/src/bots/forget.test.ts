import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { memoryAccountStore, ACCOUNT_PLAN } from "./account"
import { forgetBotTraces } from "./forget"
import { EMPTY_MEMORY, type BotMemory, type MemoryStore } from "./memory"
import { memoryRoutineStore, removeRoutinesOf, type Routine, type RoutineBook } from "./routine"

const routine = (id: string, bot: string): Routine =>
  ({ id, bot, prompt: "p", every: { kind: "hours", hours: 24 }, consent: "c", createdAt: 1 }) as unknown as Routine

const book = (): RoutineBook => ({
  routines: [routine("r1", "C:/a/news.md"), routine("r2", "C:/a/other.md"), routine("r3", "C:/a/news.md")],
  logs: { r1: { runs: 3 }, r2: { runs: 1 }, r3: { runs: 2 } } as unknown as RoutineBook["logs"],
  plans: {},
})

describe("a deleted bot's traces (full review 2026-10-06, bots 17)", () => {
  test("removeRoutinesOf takes a bot's routines and their logs and leaves the others", () => {
    const next = removeRoutinesOf(book(), "C:/a/news.md")
    expect(next.routines.map((r) => r.id)).toEqual(["r2"])
    expect(Object.keys(next.logs)).toEqual(["r2"])
    const untouched = book()
    expect(removeRoutinesOf(untouched, "C:/a/none.md")).toBe(untouched)
  })

  test("its memory, account choice and routines are cleared; another bot's are not", () => {
    const routines = memoryRoutineStore(book())
    const account = memoryAccountStore()
    const saved = new Map<string, BotMemory>([
      ["C:/a/news.md", { notes: ["una nota"], user: ["profilo"] }],
      ["C:/a/other.md", { notes: ["altra"], user: [] }],
    ])
    const memory: MemoryStore = {
      get: (bot) => saved.get(bot) ?? EMPTY_MEMORY,
      set: (bot, value) => void saved.set(bot, value),
    }
    account.set("C:/a/news.md", { mode: "key", key: "k" })
    account.set("C:/a/other.md", { mode: "key", key: "o" })

    forgetBotTraces("C:/a/news.md", { memory, account, routines: (change) => routines.set(change(routines.get())) })

    expect(routines.get().routines.map((r) => r.id)).toEqual(["r2"])
    expect(memory.get("C:/a/news.md")).toEqual(EMPTY_MEMORY)
    expect(account.get("C:/a/news.md")).toEqual(ACCOUNT_PLAN)
    expect(memory.get("C:/a/other.md").notes).toEqual(["altra"])
    expect(account.get("C:/a/other.md")).toEqual({ mode: "key", key: "o" })
  })

  test("the card forgets them after the file is deleted, and its routine and memory sections are keyed on the bot (bots 16)", () => {
    const source = readFileSync(join(__dirname, "bots.tsx"), "utf-8")
    expect(source).toContain("forgetBotTraces(props.bot.path,")
    const at = source.indexOf("<RoutineSection bot={props.bot}")
    const before = source.slice(Math.max(0, at - 400), at)
    expect(before).toContain("<Show when={props.bot.path} keyed>")
  })
})
