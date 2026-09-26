import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createTalkArchive, migrateTalkKeys, type TalkDisk } from "./store"
import {
  TALK_ARCHIVE_MAX,
  TOOL_OUTPUT_MAX,
  TALK_KEY_PREFIX,
  appendMessage,
  applyExit,
  applyJsonLine,
  emptyTalk,
  hasThreadTotals,
  errorText,
  formatWhen,
  lastLine,
  mentionIn,
  noteReportedModel,
  noteTurnUsage,
  parseTalk,
  permissionAnswered,
  sendMessage,
  serializeTalk,
  sumTokens,
  talkKey,
  type Talk,
} from "./talk"

const T0 = Date.UTC(2026, 8, 15, 10, 0, 0)

/*
 * One line of a CLI that prints JSON, folded by `applyJsonLine`: an event's
 * `text` becomes the bot's words. The reassembly is the one Claude Code's and
 * Codex's adapters share (`runners.ts`).
 */
const event = (text: string) => JSON.stringify({ type: "text", text })
const fold = (talk: Talk, line: string) =>
  applyJsonLine(talk, line, T0, (current, parsed) =>
    typeof parsed["text"] === "string" ? appendMessage(current, { role: "bot", text: parsed["text"] }, T0) : current,
  )

describe("applyJsonLine", () => {
  test("lines that are not json are ignored, a «Permission required» line too: a question is an event with an id (B8d)", () => {
    const quiet = fold(emptyTalk(), "INFO something happened")
    expect(quiet.messages).toHaveLength(0)
    expect(quiet.status).toBe("idle")

    const line = fold(emptyTalk(), "[36m◆[0m  Permission required: bash (bun test)")
    expect(line.status).toBe("idle")
    expect(line.permission).toBeUndefined()
  })

  test("a broken json line is not a message", () => {
    const talk = fold(emptyTalk(), '{"type": "text", "text": ')
    expect(talk.messages).toHaveLength(0)
  })

  test("an event cut into rows by the pty is glued back together", () => {
    // ConPTY re-renders at the terminal's width: one event, three rows.
    const whole = event("una risposta abbastanza lunga da essere spezzata in più righe dal terminale, e oltre")
    const rows = [whole.slice(0, 40), whole.slice(40, 80), whole.slice(80)]
    let talk = emptyTalk()
    for (const row of rows) talk = fold(talk, row)
    expect(talk.partial).toBeUndefined()
    expect(talk.messages.map((m) => m.role)).toEqual(["bot"])
    expect(talk.messages[0]?.text).toContain("spezzata in più righe")
  })

  test("colour codes around an event do not hide it", () => {
    const talk = fold(emptyTalk(), "[0m" + event("ok") + "[K")
    expect(talk.messages.at(-1)?.text).toBe("ok")
  })

  test("pieces that never become an event are dropped past the limit", () => {
    let talk = fold(emptyTalk(), "{" + "x".repeat(1000))
    expect(talk.partial).toBeDefined()
    for (let i = 0; i < 300; i++) talk = fold(talk, "y".repeat(1000))
    expect(talk.partial).toBeUndefined()
    expect(talk.messages).toHaveLength(0)
  })
})

describe("usage and errors, as the events carry them", () => {
  test("tokens are summed across nested records", () => {
    expect(sumTokens({ input: 100, output: 20, reasoning: 0, cache: { read: 30, write: 0 } })).toBe(150)
    expect(sumTokens(undefined)).toBe(0)
  })

  test("an error's words: its message, its data's message, or its name", () => {
    expect(errorText({ name: "ProviderError", data: { message: "chiave scaduta" } })).toBe("chiave scaduta")
    expect(errorText("boom")).toBe("boom")
    expect(errorText({ name: "APIError" })).toBe("APIError")
  })
})

describe("permissions", () => {
  test("once answered the turn is working again", () => {
    const asked: Talk = { ...emptyTalk(), status: "waiting", permission: { requestID: "per_1", permission: "bash", patterns: "x", askedAt: T0 } }
    const answered = permissionAnswered(asked, T0 + 5)
    expect(answered.permission).toBeUndefined()
    expect(answered.status).toBe("working")
  })
})

/** A turn that ended with the CLI's own error on the thread. */
const failedWith = (talk: Talk, text: string): Talk => ({ ...appendMessage(talk, { role: "error", text }, T0), status: "error" })

describe("applyExit", () => {
  test("a clean exit ends the turn idle", () => {
    const talk = applyExit(sendMessage(emptyTalk(), "x", T0), 0, T0 + 9)
    expect(talk.status).toBe("idle")
    expect(talk.updatedAt).toBe(T0 + 9)
  })

  test("a failing exit says so once, and not again after an error event", () => {
    const failed = applyExit(emptyTalk(), 1, T0)
    expect(failed.messages.at(-1)?.text).toBe("nikcli è uscito con codice 1.")
    const afterError = applyExit(failedWith(emptyTalk(), "boom"), 1, T0)
    expect(afterError.messages).toHaveLength(1)
    expect(afterError.status).toBe("error")
  })

  test("a turn ended by the plan's limit says nothing will retry it, once", () => {
    const limited = failedWith(sendMessage(emptyTalk(), "x", T0), "Claude AI usage limit reached")
    const ended = applyExit(limited, 1, T0 + 1, "Claude Code")
    expect(ended.limited).toBe(true)
    expect(ended.messages.at(-1)?.text).toContain("ADE non riprova")
    const again = sendMessage(ended, "ancora", T0 + 3)
    expect(again.limited).toBeUndefined()
    const done = applyExit(appendMessage(again, { role: "bot", text: "Fatto." }, T0 + 4), 0, T0 + 5, "Claude Code")
    expect(done.limited).toBeUndefined()
    expect(parseTalk(serializeTalk(ended)).limited).toBeUndefined()
    expect(applyExit(ended, 1, T0 + 2, "Claude Code").messages).toHaveLength(ended.messages.length)
  })
})

describe("lastLine", () => {
  test("says what happened last, in one line, and the fallback when nothing has", () => {
    expect(lastLine(emptyTalk(), "Revisiona le PR")).toBe("Revisiona le PR")
    const said = appendMessage(emptyTalk(), { role: "bot", text: "Fatto.\nDue righe." }, T0)
    expect(lastLine(said, "")).toBe("Fatto. Due righe.")
    const ran = appendMessage(said, { role: "tool", tool: "bash", text: "bun test" }, T0)
    expect(lastLine(ran, "")).toBe("bash: bun test")
    expect(lastLine(sendMessage(ran, "grazie", T0), "")).toBe("Tu: grazie")
    const asked: Talk = { ...ran, status: "waiting", permission: { permission: "bash", patterns: "rm", askedAt: T0 } }
    expect(lastLine(asked, "")).toBe("Chiede il permesso: bash")
  })
})

describe("formatWhen", () => {
  const now = new Date(2026, 8, 15, 10, 30).getTime()
  test("ora, the time today, ieri, the weekday, the date", () => {
    expect(formatWhen(undefined, now)).toBe("")
    expect(formatWhen(now - 20_000, now)).toBe("ora")
    expect(formatWhen(new Date(2026, 8, 15, 9, 5).getTime(), now)).toBe("09:05")
    expect(formatWhen(new Date(2026, 8, 14, 23, 0).getTime(), now)).toBe("ieri")
    expect(formatWhen(new Date(2026, 8, 12, 9, 0).getTime(), now)).toBe("sab")
    expect(formatWhen(new Date(2026, 7, 1, 9, 0).getTime(), now)).toBe("1 ago")
  })
})

describe("mentionIn", () => {
  const bots = ["revisore", "tester"]
  test("finds a bot named after @ and returns the text without it", () => {
    expect(mentionIn("@tester confermi con un test?", bots)).toEqual({ identifier: "tester", rest: "confermi con un test?" })
    expect(mentionIn("guarda tu @Revisore", bots)).toEqual({ identifier: "revisore", rest: "guarda tu" })
  })
  test("ignores names that are not bots and @ inside words", () => {
    expect(mentionIn("@nessuno ciao", bots)).toBeUndefined()
    expect(mentionIn("scrivi a mail@tester.it", bots)).toBeUndefined()
  })
})

/** A turn that answered, in session `ses_abc`. */
const answered = (): Talk => ({ ...appendMessage(sendMessage(emptyTalk(), "ciao", T0), { role: "bot", text: "Ciao." }, T0), sessionId: "ses_abc" })

describe("storage", () => {
  test("round-trips the thread, dropping the running state", () => {
    const talk = answered()
    const back = parseTalk(serializeTalk(talk))
    expect(back.sessionId).toBe("ses_abc")
    expect(back.messages).toEqual(talk.messages)
    expect(back.status).toBe("idle")
  })
  test("tolerates garbage", () => {
    expect(parseTalk("nope").messages).toHaveLength(0)
    expect(parseTalk(null).status).toBe("idle")
    expect(parseTalk('{"messages":[{"id":1}]}').messages).toHaveLength(0)
  })

  test("a secret in tool output does not land in the archive, and the printout has a size cap", () => {
    const key = "sk-or-v1-abcdefghijklmnopqrstuvwxyz0123456789"
    const talk = appendMessage(
      emptyTalk(),
      { role: "tool", tool: "bash", text: `echo ${key}`, output: `${key}\n${"x".repeat(TOOL_OUTPUT_MAX)}` },
      T0,
    )
    const stored = serializeTalk(talk)
    expect(stored).not.toContain(key)
    expect(stored).toContain("[nascosto]")
    expect(stored).toContain("…troncato")
    expect(stored.length).toBeLessThanOrEqual(TALK_ARCHIVE_MAX)
  })

  test("lastWords go through the same filter before they are stored", () => {
    const key = "ghp_abcdefghijklmnopqrstuvwxyz"
    const talk = applyExit(emptyTalk(), 1, T0, "nikcli", `untrusted: ${key}`)
    expect(talk.messages.at(-1)?.text).not.toContain(key)
    expect(serializeTalk(talk)).not.toContain(key)
  })

  test("the archive stays under its cap by dropping the oldest messages", () => {
    let talk = emptyTalk()
    for (let i = 0; i < 40; i++) {
      talk = appendMessage(talk, { role: "tool", tool: "bash", text: `cmd ${i}`, output: "y".repeat(TOOL_OUTPUT_MAX) }, T0 + i)
    }
    const stored = serializeTalk(talk)
    expect(stored.length).toBeLessThanOrEqual(TALK_ARCHIVE_MAX)
    expect(parseTalk(stored).messages.length).toBeLessThan(40)
  })

  test("a global bot's archive in another project is empty, session included", () => {
    const path = "C:/Users/me/AppData/nikcli/agent/revisore.md"
    const keyA = talkKey(path, "C:/proj-a")
    const keyB = talkKey(path, "C:/proj-b")
    expect(keyA).not.toBe(keyB)
    const disk = new Map<string, string>()
    const archive = createTalkArchive({
      getItem: (k) => disk.get(k) ?? null,
      setItem: (k, v) => void disk.set(k, v),
    })
    archive.flush(keyA, answered())
    expect(archive.read(keyA).sessionId).toBe("ses_abc")
    expect(archive.read(keyB).sessionId).toBeUndefined()
    expect(archive.read(keyB).messages).toHaveLength(0)
    expect(disk.get(keyA)).not.toContain("sk-")
  })

  test("a turn on the default model that names a free one is free, and so is what it already counted", () => {
    const spend = (talk: Talk, tokens: number) =>
      noteTurnUsage({ ...talk, tokens: talk.tokens + tokens }, tokens, 0, false)
    const close = (talk: Talk) => noteTurnUsage(talk, 0, 0, true)
    // An earlier turn on a model the default resolved to, not free: metered it stays.
    let talk: Talk = { ...sendMessage(emptyTalk(), "uno", T0), turnMode: "metered" }
    talk = noteReportedModel(talk, { providerID: "openrouter", modelID: "vendor/a-pagamento" })
    talk = close(spend(talk, 7))
    expect(talk.byMode).toEqual({ metered: { tokens: 7, costUsd: 0 } })
    // «Predefinito» and a :free model: usage before the model is named moves over too.
    talk = { ...sendMessage(talk, "due", T0 + 1), turnMode: "metered" }
    talk = spend(talk, 3)
    talk = noteReportedModel(talk, { providerID: "openrouter", modelID: "nvidia/nemotron-3.5-lightning:free" })
    talk = close(spend(talk, 15))
    expect(talk.byMode).toEqual({ metered: { tokens: 7, costUsd: 0 }, free: { tokens: 18, costUsd: 0 } })
    expect(talk.lastTurn?.mode).toBe("free")
    // A thread only ever on the free model has no «a consumo» row at all.
    let only: Talk = { ...sendMessage(emptyTalk(), "tre", T0 + 2), turnMode: "metered" }
    only = spend(only, 4)
    only = noteReportedModel(only, { modelID: "openrouter/x:free" })
    expect(only.byMode).toEqual({ free: { tokens: 4, costUsd: 0 } })
    // A named model chose its mode at the start: a free id reported later changes nothing.
    let named: Talk = { ...sendMessage(emptyTalk(), "quattro", T0 + 3), turnMode: "api" }
    named = noteReportedModel(spend(named, 2), { modelID: "x:free" })
    expect(named.byMode).toEqual({ api: { tokens: 2, costUsd: 0 } })
  })

  test("a turn that cost something is never moved to free by a :free name", () => {
    const spend = (talk: Talk, tokens: number, costUsd: number) =>
      noteTurnUsage({ ...talk, tokens: talk.tokens + tokens, costUsd: talk.costUsd + costUsd }, tokens, costUsd, false)
    const close = (talk: Talk) => noteTurnUsage(talk, 0, 0, true)
    // Paid before the name arrived: the router fell back on a paid model, «a consumo» it stays.
    let paid: Talk = { ...sendMessage(emptyTalk(), "uno", T0), turnMode: "metered" }
    paid = spend(paid, 5, 0.002)
    paid = close(noteReportedModel(paid, { modelID: "openrouter/x:free" }))
    expect(paid.byMode).toEqual({ metered: { tokens: 5, costUsd: 0.002 } })
    expect(paid.lastTurn?.mode).toBe("metered")
    // Named free first, then a cost: back to «a consumo», with what it had counted.
    let later: Talk = { ...sendMessage(emptyTalk(), "due", T0 + 1), turnMode: "metered" }
    later = noteReportedModel(spend(later, 3, 0), { modelID: "openrouter/x:free" })
    expect(later.byMode).toEqual({ free: { tokens: 3, costUsd: 0 } })
    later = close(spend(later, 4, 0.001))
    expect(later.byMode).toEqual({ metered: { tokens: 7, costUsd: 0.001 } })
    expect(later.lastTurn?.mode).toBe("metered")
  })

  test("the last turn keeps its own tokens and the model the event named", () => {
    const spend = (talk: Talk, tokens: number, costUsd: number) =>
      noteTurnUsage({ ...talk, tokens: talk.tokens + tokens, costUsd: talk.costUsd + costUsd }, tokens, costUsd, true)
    let talk = sendMessage(emptyTalk(), "uno", T0)
    talk = noteReportedModel(talk, { providerID: "openai", modelID: "gpt-5" })
    talk = spend(talk, 12, 0.01)
    expect(talk.tokens).toBe(12)
    expect(talk.costUsd).toBeCloseTo(0.01)
    expect(talk.lastTurn).toEqual({ model: "openai/gpt-5", tokens: 12, costUsd: 0.01 })
    talk = sendMessage(talk, "due", T0 + 1)
    talk = spend(talk, 5, 0.002)
    expect(talk.tokens).toBe(17)
    expect(talk.costUsd).toBeCloseTo(0.012)
    expect(talk.lastTurn).toEqual({ tokens: 5, costUsd: 0.002 })
    expect(parseTalk(serializeTalk(talk)).lastTurn).toEqual({ tokens: 5, costUsd: 0.002 })
    expect(parseTalk(serializeTalk(talk)).tokens).toBe(17)
  })

  test("a bot message that repeats a key does not keep it", () => {
    const key = "sk-or-v1-abcdefghijklmnopqrstuvwxyz0123456789"
    const talk = appendMessage(emptyTalk(), { role: "bot", text: `ho letto ${key}` }, T0)
    expect(talk.messages[0]?.text).not.toContain(key)
    expect(serializeTalk(talk)).not.toContain(key)
    expect(serializeTalk(talk)).toContain("[nascosto]")
  })

  test("a burst of lines is one write, not one per line", () => {
    const disk = new Map<string, string>()
    const queued: (() => void)[] = []
    const archive = createTalkArchive(
      { getItem: (k) => disk.get(k) ?? null, setItem: (k, v) => void disk.set(k, v) },
      400,
      (run) => {
        queued.push(run)
        return () => {
          const at = queued.indexOf(run)
          if (at >= 0) queued.splice(at, 1)
        }
      },
    )
    const key = talkKey("/agent/bot.md", "C:/proj")
    const talk = appendMessage(emptyTalk(), { role: "tool", tool: "bash", text: "ls", output: "a\n" }, T0)
    for (let i = 0; i < 5; i++) archive.save(key, talk)
    expect(disk.size).toBe(0)
    expect(queued).toHaveLength(1)
    queued[0]!()
    expect(disk.size).toBe(1)
  })
})

function memoryDisk(initial: Record<string, string> = {}): TalkDisk & { readonly data: Map<string, string> } {
  const data = new Map(Object.entries(initial))
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
    keys: () => [...data.keys()],
  }
}

describe("old thread keys", () => {
  const secret = "sk-or-v1-abcdefghijklmnopqrstuvwxyz0123456789"

  test("a large project thread moves under the new key, capped, and the old key is gone", () => {
    const path = "C:/proj/.nikcli/agent/revisore.md"
    const old = `${TALK_KEY_PREFIX}${path}`
    const disk = memoryDisk({
      [old]: JSON.stringify({
        sessionId: "ses_old",
        messages: [
          { id: "t-1", role: "tool", tool: "bash", text: "cat .env", output: `${secret}${"y".repeat(300_000)}`, at: 1 },
          { id: "b-1", role: "bot", text: `ecco ${secret}`, at: 2 },
        ],
        tokens: 3,
        costUsd: 0,
        updatedAt: 2,
      }),
    })
    migrateTalkKeys(disk, "C:/proj")
    expect(disk.data.has(old)).toBe(false)
    const next = disk.data.get(talkKey(path, "C:/proj"))
    expect(next).toBeDefined()
    expect(next!.length).toBeLessThanOrEqual(TALK_ARCHIVE_MAX)
    expect(next).not.toContain(secret)
    expect(parseTalk(next).sessionId).toBe("ses_old")
  })

  test("a global bot's old thread follows the open project and drops the session id", () => {
    const path = "C:/Users/me/AppData/Roaming/nikcli/agent/revisore.md"
    const old = `${TALK_KEY_PREFIX}${path}`
    const disk = memoryDisk({
      [old]: JSON.stringify({
        sessionId: "ses_global",
        messages: [{ id: "u-1", role: "user", text: "ciao", at: 1 }],
        tokens: 0,
        costUsd: 0,
        updatedAt: 1,
      }),
    })
    migrateTalkKeys(disk, "C:/proj")
    expect(disk.data.has(old)).toBe(false)
    const stored = parseTalk(disk.data.get(talkKey(path, "C:/proj")))
    expect(stored.sessionId).toBeUndefined()
    expect(stored.messages).toHaveLength(1)
  })

  test("a value that cannot be stored still loses the old key", () => {
    const path = "C:/nope.md"
    const old = `${TALK_KEY_PREFIX}${path}`
    const disk = memoryDisk({ [old]: "{" })
    disk.setItem = () => {
      throw new Error("piena")
    }
    migrateTalkKeys(disk, "")
    expect(disk.data.has(old)).toBe(false)
  })

  test("a bot from another project keeps that project's root and its session", () => {
    const path = "C:/repo-A/.nikcli/agent/x.md"
    const old = `${TALK_KEY_PREFIX}${path}`
    const disk = memoryDisk({
      [old]: JSON.stringify({
        sessionId: "ses_a",
        messages: [{ id: "u-1", role: "user", text: "ciao", at: 1 }],
        tokens: 0,
        costUsd: 0,
        updatedAt: 1,
      }),
    })
    migrateTalkKeys(disk, "C:/repo-B")
    expect(disk.data.has(old)).toBe(false)
    expect(disk.data.has(talkKey(path, "C:/repo-B"))).toBe(false)
    const stored = parseTalk(disk.data.get(talkKey(path, "C:/repo-A")))
    expect(stored.sessionId).toBe("ses_a")
    expect(stored.messages).toHaveLength(1)
  })

  test("the agents spelling is a project too, and a closed window still migrates", () => {
    const path = "D:\\work\\app\\.nikcli\\agents\\team\\bot.md"
    const globalPath = "C:/Users/me/AppData/Roaming/nikcli/agent/revisore.md"
    const disk = memoryDisk({
      [`${TALK_KEY_PREFIX}${path}`]: JSON.stringify({
        sessionId: "ses_app",
        messages: [{ id: "u-1", role: "user", text: "a", at: 1 }],
        tokens: 0,
        costUsd: 0,
        updatedAt: 1,
      }),
      [`${TALK_KEY_PREFIX}${globalPath}`]: JSON.stringify({
        sessionId: "ses_global",
        messages: [{ id: "u-2", role: "user", text: "b", at: 2 }],
        tokens: 0,
        costUsd: 0,
        updatedAt: 2,
      }),
    })
    migrateTalkKeys(disk, "")
    expect(parseTalk(disk.data.get(talkKey(path, "D:\\work\\app"))).sessionId).toBe("ses_app")
    const globalTalk = parseTalk(disk.data.get(talkKey(globalPath, "")))
    expect(globalTalk.sessionId).toBeUndefined()
    expect(globalTalk.messages).toHaveLength(1)
  })

  test("the old key is removed before the new one is written", () => {
    const path = "C:/repo-A/.nikcli/agent/x.md"
    const old = `${TALK_KEY_PREFIX}${path}`
    const disk = memoryDisk({
      [old]: JSON.stringify({ sessionId: "s", messages: [], tokens: 0, costUsd: 0, updatedAt: 1 }),
    })
    let wroteWhileOldRemained = false
    const write = disk.setItem.bind(disk)
    disk.setItem = (key, value) => {
      if (disk.data.has(old)) wroteWhileOldRemained = true
      write(key, value)
    }
    migrateTalkKeys(disk, "")
    expect(wroteWhileOldRemained).toBe(false)
    expect(disk.data.has(old)).toBe(false)
    expect(disk.data.has(talkKey(path, "C:/repo-A"))).toBe(true)
  })
})

describe("a full archive", () => {
  test("drops the least recent thread and retries the write once", () => {
    const keep = talkKey("/b.md", "C:/proj")
    const drop = talkKey("/a.md", "C:/proj")
    const fresh = talkKey("/c.md", "C:/proj")
    const data = new Map<string, string>([
      [drop, JSON.stringify({ messages: [], updatedAt: 1 })],
      [keep, JSON.stringify({ messages: [], updatedAt: 50 })],
    ])
    let blocked = true
    const disk: TalkDisk = {
      getItem: (key) => data.get(key) ?? null,
      setItem: (key, value) => {
        if (blocked && key === fresh) {
          const error = new Error("quota")
          error.name = "QuotaExceededError"
          throw error
        }
        data.set(key, value)
      },
      removeItem: (key) => {
        data.delete(key)
        blocked = false
      },
      keys: () => [...data.keys()],
    }
    createTalkArchive(disk).flush(fresh, appendMessage(emptyTalk(), { role: "bot", text: "ok" }, T0))
    expect(data.has(fresh)).toBe(true)
    expect(data.has(drop)).toBe(false)
    expect(data.has(keep)).toBe(true)
  })
})

/* bot-sforzo, A occhio: «in questa conversazione:» followed by nothing. */
describe("the thread's totals", () => {
  test("there are none before a turn, and some once one counted", () => {
    expect(hasThreadTotals(emptyTalk())).toBe(false)
    expect(hasThreadTotals({ ...emptyTalk(), tokens: 12 })).toBe(true)
    expect(hasThreadTotals({ ...emptyTalk(), costUsd: 0.01 })).toBe(true)
    // A free or plan turn totals by its mode, with zero cost.
    expect(hasThreadTotals({ ...emptyTalk(), byMode: { free: { tokens: 0, costUsd: 0 } } })).toBe(true)
  })

  test("the composer and the card say the totals only when there are some", () => {
    const view = readFileSync(join(import.meta.dir, "bots.tsx"), "utf8")
    const said = view.split('{t("bots.conversation.total")}').length - 1
    const guarded = view.split("<Show when={hasThreadTotals(props.talk)}>").length - 1
    expect(said).toBe(2)
    expect(guarded).toBe(2)
  })
})
