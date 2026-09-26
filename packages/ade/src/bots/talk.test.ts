import { describe, expect, test } from "bun:test"
import { createTalkArchive, migrateTalkKeys, type TalkDisk } from "./store"
import {
  TALK_ARCHIVE_MAX,
  TOOL_OUTPUT_MAX,
  TALK_KEY_PREFIX,
  appendMessage,
  applyExit,
  applyLine,
  emptyTalk,
  formatWhen,
  lastLine,
  mentionIn,
  parseTalk,
  permissionAnswered,
  runArgs,
  sendMessage,
  serializeTalk,
  talkKey,
  type Talk,
} from "./talk"

const T0 = Date.UTC(2026, 8, 15, 10, 0, 0)

function event(type: string, extra: Record<string, unknown>): string {
  return JSON.stringify({ type, timestamp: T0 + 1000, sessionID: "ses_abc", ...extra })
}

describe("runArgs", () => {
  test("names the agent, asks for json, and puts the message after --", () => {
    expect(runArgs({ identifier: "revisore", message: "ciao" })).toEqual([
      "run", "--agent", "revisore", "--format", "json", "--", "ciao",
    ])
  })

  test("continues the session and pins model and effort when known", () => {
    expect(
      runArgs({ identifier: "revisore", message: "-x", sessionId: "ses_1", model: "anthropic/claude-sonnet-5", effort: "high" }),
    ).toEqual([
      "run", "--agent", "revisore", "--format", "json",
      "--model", "anthropic/claude-sonnet-5", "--variant", "high", "--session", "ses_1",
      "--", "-x",
    ])
  })
})

describe("applyLine", () => {
  test("a text event becomes the bot's message and records the session", () => {
    const talk = applyLine(sendMessage(emptyTalk(), "ciao", T0), event("text", { part: { type: "text", text: "Ciao a te." } }), T0)
    expect(talk.sessionId).toBe("ses_abc")
    expect(talk.messages.map((m) => [m.role, m.text])).toEqual([["user", "ciao"], ["bot", "Ciao a te."]])
    expect(talk.status).toBe("working")
  })

  test("a tool event keeps the tool, its title and its output", () => {
    const talk = applyLine(
      emptyTalk(),
      event("tool_use", { part: { type: "tool", tool: "bash", state: { title: "bun test", output: "1 pass\n" } } }),
      T0,
    )
    const last = talk.messages.at(-1)
    expect(last?.role).toBe("tool")
    expect(last?.tool).toBe("bash")
    expect(last?.text).toBe("bun test")
    expect(last?.output).toBe("1 pass\n")
  })

  test("a tool with no title shows its input, and one with neither shows its name", () => {
    const withInput = applyLine(emptyTalk(), event("tool_use", { part: { tool: "read", state: { input: { path: "a.ts" } } } }), T0)
    expect(withInput.messages.at(-1)?.text).toBe('{"path":"a.ts"}')
    const bare = applyLine(emptyTalk(), event("tool_use", { part: { tool: "glob", state: { input: {} } } }), T0)
    expect(bare.messages.at(-1)?.text).toBe("glob")
  })

  test("step_finish accumulates tokens across nested records and cost", () => {
    const one = applyLine(
      emptyTalk(),
      event("step_finish", { part: { tokens: { input: 100, output: 20, reasoning: 0, cache: { read: 30, write: 0 } }, cost: 0.01 } }),
      T0,
    )
    const two = applyLine(one, event("step_finish", { part: { tokens: { input: 50, output: 5 }, cost: 0.005 } }), T0)
    expect(two.tokens).toBe(205)
    expect(two.costUsd).toBeCloseTo(0.015)
  })

  /*
   * B7, live: nikcli 1.389 answers and then does not exit inside a git
   * repository, for minutes. The turn ends at its own last step instead.
   */
  test("the turn's own step_finish with reason stop ends it, with that step's tokens and cost", () => {
    const asked = sendMessage(emptyTalk(), "ciao", T0)
    const working = applyLine(asked, event("step_start", { part: { type: "step-start" } }), T0)
    const text = applyLine(working, event("text", { part: { type: "text", text: "GLOBALE" } }), T0)
    expect(text.ended).toBeUndefined()
    const done = applyLine(text, event("step_finish", { part: { reason: "stop", tokens: { input: 100, output: 5 }, cost: 0.002 } }), T0)
    expect(done.ended).toBe(true)
    expect(done.tokens).toBe(105)
    expect(done.costUsd).toBeCloseTo(0.002)
    // The next message is a turn of its own again.
    expect(sendMessage(done, "ancora", T0).ended).toBeUndefined()
  })

  test("a step that calls tools does not end the turn, nor does a length or error stop", () => {
    const asked = applyLine(sendMessage(emptyTalk(), "ciao", T0), event("step_start", {}), T0)
    for (const reason of ["tool-calls", "tool_calls", "length", "error", undefined]) {
      const step = applyLine(asked, event("step_finish", { part: { reason, tokens: { input: 1 } } }), T0)
      expect(step.ended).toBeUndefined()
    }
  })

  test("a sub-agent's step_finish stop, in another session, does not end the turn", () => {
    const asked = applyLine(sendMessage(emptyTalk(), "ciao", T0), event("step_start", {}), T0)
    const child = applyLine(asked, event("step_finish", { sessionID: "ses_figlio", part: { reason: "stop", tokens: { input: 7 } } }), T0)
    expect(child.ended).toBeUndefined()
    expect(child.tokens).toBe(7)
    const own = applyLine(child, event("step_finish", { part: { reason: "stop" } }), T0)
    expect(own.ended).toBe(true)
    // A resumed conversation ends on its own session too.
    const resumed = applyLine(sendMessage(own, "e poi?", T0), event("step_finish", { part: { reason: "stop" } }), T0)
    expect(resumed.ended).toBe(true)
  })

  test("an error event ends the turn as an error with its message", () => {
    const talk = applyLine(emptyTalk(), event("error", { error: { name: "ProviderError", data: { message: "chiave scaduta" } } }), T0)
    expect(talk.status).toBe("error")
    expect(talk.messages.at(-1)).toMatchObject({ role: "error", text: "chiave scaduta" })
  })

  test("lines that are not json are ignored, a «Permission required» line too: a question is an event with an id (B8d)", () => {
    const quiet = applyLine(emptyTalk(), "INFO something happened", T0)
    expect(quiet.messages).toHaveLength(0)
    expect(quiet.status).toBe("idle")

    const line = applyLine(emptyTalk(), "[36m◆[0m  Permission required: bash (bun test)", T0)
    expect(line.status).toBe("idle")
    expect(line.permission).toBeUndefined()
  })

  test("a broken json line is not a message", () => {
    const talk = applyLine(emptyTalk(), '{"type": "text", "part": ', T0)
    expect(talk.messages).toHaveLength(0)
  })

  test("an event cut into rows by the pty is glued back together", () => {
    // ConPTY re-renders at the terminal's width: one event, three rows.
    const whole = event("text", { part: { type: "text", text: "una risposta abbastanza lunga da essere spezzata in più righe dal terminale" } })
    const rows = [whole.slice(0, 60), whole.slice(60, 120), whole.slice(120)]
    let talk = emptyTalk()
    for (const row of rows) talk = applyLine(talk, row, T0)
    expect(talk.partial).toBeUndefined()
    expect(talk.messages.map((m) => m.role)).toEqual(["bot"])
    expect(talk.messages[0]?.text).toContain("spezzata in più righe")
  })

  test("colour codes around an event do not hide it", () => {
    const talk = applyLine(emptyTalk(), "[0m" + event("text", { part: { text: "ok" } }) + "[K", T0)
    expect(talk.messages.at(-1)?.text).toBe("ok")
  })

  test("pieces that never become an event are dropped past the limit", () => {
    let talk = applyLine(emptyTalk(), "{" + "x".repeat(1000), T0)
    expect(talk.partial).toBeDefined()
    for (let i = 0; i < 300; i++) talk = applyLine(talk, "y".repeat(1000), T0)
    expect(talk.partial).toBeUndefined()
    expect(talk.messages).toHaveLength(0)
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

describe("applyExit", () => {
  test("a clean exit ends the turn idle", () => {
    const talk = applyExit(sendMessage(emptyTalk(), "x", T0), 0, T0 + 9)
    expect(talk.status).toBe("idle")
    expect(talk.updatedAt).toBe(T0 + 9)
  })

  test("a failing exit says so once, and not again after an error event", () => {
    const failed = applyExit(emptyTalk(), 1, T0)
    expect(failed.messages.at(-1)?.text).toBe("nikcli è uscito con codice 1.")
    const afterError = applyExit(applyLine(emptyTalk(), event("error", { error: "boom" }), T0), 1, T0)
    expect(afterError.messages).toHaveLength(1)
    expect(afterError.status).toBe("error")
  })

  test("a turn ended by the plan's limit says nothing will retry it, once", () => {
    const limited = applyLine(sendMessage(emptyTalk(), "x", T0), event("error", { error: "Claude AI usage limit reached" }), T0)
    const ended = applyExit(limited, 1, T0 + 1, "Claude Code")
    expect(ended.limited).toBe(true)
    expect(ended.messages.at(-1)?.text).toContain("ADE non riprova")
    const again = sendMessage(ended, "ancora", T0 + 3)
    expect(again.limited).toBeUndefined()
    const done = applyExit(applyLine(again, event("text", { part: { text: "Fatto." } }), T0 + 4), 0, T0 + 5, "Claude Code")
    expect(done.limited).toBeUndefined()
    expect(parseTalk(serializeTalk(ended)).limited).toBeUndefined()
    expect(applyExit(ended, 1, T0 + 2, "Claude Code").messages).toHaveLength(ended.messages.length)
  })
})

describe("lastLine", () => {
  test("says what happened last, in one line, and the fallback when nothing has", () => {
    expect(lastLine(emptyTalk(), "Revisiona le PR")).toBe("Revisiona le PR")
    const said = applyLine(emptyTalk(), event("text", { part: { text: "Fatto.\nDue righe." } }), T0)
    expect(lastLine(said, "")).toBe("Fatto. Due righe.")
    const ran = applyLine(said, event("tool_use", { part: { tool: "bash", state: { title: "bun test" } } }), T0)
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

describe("storage", () => {
  test("round-trips the thread, dropping the running state", () => {
    const talk = applyLine(sendMessage(emptyTalk(), "ciao", T0), event("text", { part: { text: "Ciao." } }), T0)
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
    const talk = applyLine(
      emptyTalk(),
      event("tool_use", { part: { type: "tool", tool: "bash", state: { title: `echo ${key}`, output: `${key}\n${"x".repeat(TOOL_OUTPUT_MAX)}` } } }),
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
    const talk = applyLine(sendMessage(emptyTalk(), "ciao", T0), event("text", { part: { text: "Ciao." } }), T0)
    archive.flush(keyA, talk)
    expect(archive.read(keyA).sessionId).toBe("ses_abc")
    expect(archive.read(keyB).sessionId).toBeUndefined()
    expect(archive.read(keyB).messages).toHaveLength(0)
    expect(disk.get(keyA)).not.toContain("sk-")
  })

  test("the last turn keeps its own tokens and the model the event named", () => {
    let talk = sendMessage(emptyTalk(), "uno", T0)
    talk = applyLine(
      talk,
      event("step_start", { part: { type: "step-start", model: { providerID: "openai", modelID: "gpt-5" } } }),
      T0,
    )
    talk = applyLine(talk, event("step_finish", { part: { reason: "stop", tokens: { input: 10, output: 2 }, cost: 0.01 } }), T0)
    expect(talk.tokens).toBe(12)
    expect(talk.costUsd).toBeCloseTo(0.01)
    expect(talk.lastTurn).toEqual({ model: "openai/gpt-5", tokens: 12, costUsd: 0.01 })
    talk = sendMessage(talk, "due", T0 + 1)
    talk = applyLine(talk, event("step_finish", { part: { reason: "stop", tokens: { input: 4, output: 1 }, cost: 0.002 } }), T0 + 2)
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
