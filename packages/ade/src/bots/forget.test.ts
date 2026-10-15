import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { memoryAccountStore, ACCOUNT_PLAN } from "./account"
import { localAlwaysStore } from "./approval"
import { forgetBotTraces, forgetStoredKeys, type KeyedStorage } from "./forget"
import { sessionKey } from "./gateway/session"
import { gatewayThreadKey } from "./gateway/threads"
import { talkKey } from "./talk"
import { memoryRemoteStore, remoteKey } from "./gateway/remote"
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
    const remote = memoryRemoteStore()
    remote.set(remoteKey("C:/a/news.md", "telegram"), { commands: true, fingerprint: "f" })
    remote.set(remoteKey("C:/a/news.md", "slack"), { commands: true, fingerprint: "f" })
    remote.set(remoteKey("C:/a/other.md", "telegram"), { commands: true, fingerprint: "g" })
    account.set("C:/a/news.md", { mode: "key", key: "k" })
    account.set("C:/a/other.md", { mode: "key", key: "o" })

    forgetBotTraces("C:/a/news.md", { memory, account, remote, routines: (change) => routines.set(change(routines.get())) })

    expect(routines.get().routines.map((r) => r.id)).toEqual(["r2"])
    expect(memory.get("C:/a/news.md")).toEqual(EMPTY_MEMORY)
    expect(account.get("C:/a/news.md")).toEqual(ACCOUNT_PLAN)
    expect(remote.get(remoteKey("C:/a/news.md", "telegram")).commands).toBe(false)
    expect(remote.get(remoteKey("C:/a/news.md", "slack")).commands).toBe(false)
    expect(remote.get(remoteKey("C:/a/other.md", "telegram")).commands).toBe(true)
    expect(memory.get("C:/a/other.md").notes).toEqual(["altra"])
    expect(account.get("C:/a/other.md")).toEqual({ mode: "key", key: "o" })
  })

  /* S5 and S9 (review of the bots): «Sempre», the chats' sessions and their threads outlived the bot, kept by path. */
  const memoryStorage = (initial: Record<string, string>): KeyedStorage & { data: Map<string, string> } => {
    const data = new Map(Object.entries(initial))
    return {
      data,
      get length() {
        return data.size
      },
      key: (index) => [...data.keys()][index] ?? null,
      getItem: (key) => data.get(key) ?? null,
      setItem: (key, value) => void data.set(key, value),
      removeItem: (key) => void data.delete(key),
    }
  }

  test("its «Sempre», chat sessions, chat threads and panel thread go with it; another bot's stay", () => {
    const gone = "C:/a/news.md"
    const kept = "C:/a/other.md"
    const sessions = {
      [sessionKey(gone, "telegram", "c1")]: { project: "P", runner: "ragu", sessionId: "s1" },
      [sessionKey(gone, "slack", "c2", "t9")]: { project: "P", runner: "ragu", sessionId: "s2" },
      [sessionKey(kept, "telegram", "c1")]: { project: "P", runner: "ragu", sessionId: "s3" },
    }
    const storage = memoryStorage({
      "ade.gateway.sessions": JSON.stringify(sessions),
      [gatewayThreadKey(gone, "telegram", "c1")]: "{}",
      [gatewayThreadKey(gone, "slack", "c2", "t9")]: "{}",
      [gatewayThreadKey(kept, "telegram", "c1")]: "{}",
      [talkKey(gone, "C:/progetto")]: "{}",
      [talkKey(gone)]: "{}",
      [talkKey(kept, "C:/progetto")]: "{}",
      [`ade.bots.talk:${gone}`]: "{}",
      "altro": "x",
    })
    const always = localAlwaysStore(storage)
    always.add(gone, "gitRewrite")
    always.add(kept, "gitRewrite")
    const routines = memoryRoutineStore(book())

    forgetBotTraces(gone, {
      memory: { get: () => EMPTY_MEMORY, set: () => {} },
      account: memoryAccountStore(),
      remote: memoryRemoteStore(),
      routines: (change) => routines.set(change(routines.get())),
      always,
      storage,
    })

    expect(always.get(gone)).toEqual([])
    expect(always.get(kept)).toEqual(["gitRewrite"])
    expect(Object.keys(JSON.parse(storage.data.get("ade.gateway.sessions")!))).toEqual([sessionKey(kept, "telegram", "c1")])
    expect([...storage.data.keys()].filter((key) => key.includes(gone) && !key.includes("approvals"))).toEqual([])
    expect(storage.data.has(gatewayThreadKey(kept, "telegram", "c1"))).toBe(true)
    expect(storage.data.has(talkKey(kept, "C:/progetto"))).toBe(true)
    expect(storage.data.get("altro")).toBe("x")
  })

  test("a path that is the start of another bot's does not take that bot's keys", () => {
    const storage = memoryStorage({
      "ade.gateway.sessions": JSON.stringify({ [sessionKey("C:/a/news.md2", "telegram", "c1")]: { sessionId: "x" } }),
      [gatewayThreadKey("C:/a/news.md2", "telegram", "c1")]: "{}",
      [talkKey("C:/a/news.md2", "P")]: "{}",
    })
    forgetStoredKeys("C:/a/news.md", storage)
    expect(storage.data.size).toBe(3)
    expect(Object.keys(JSON.parse(storage.data.get("ade.gateway.sessions")!))).toHaveLength(1)
  })

  test("storage that fails takes nothing down", () => {
    const broken: KeyedStorage = {
      length: 1,
      key: () => {
        throw new Error("no")
      },
      getItem: () => {
        throw new Error("no")
      },
      setItem: () => {},
      removeItem: () => {},
    }
    expect(() => forgetStoredKeys("C:/a/news.md", broken)).not.toThrow()
  })

  test("the card forgets them after the file is deleted, and its routine and memory sections are keyed on the bot (bots 16)", () => {
    const source = readFileSync(join(__dirname, "bots.tsx"), "utf-8")
    expect(source).toContain("forgetBotTraces(props.bot.path,")
    const at = source.indexOf("<RoutineSection bot={props.bot}")
    const before = source.slice(Math.max(0, at - 400), at)
    expect(before).toContain("<Show when={props.bot.path} keyed>")
  })
})
