import { describe, expect, test } from "bun:test"
import { MAX_STORAGE_BYTES, PERMISSIONS, type Chord, type Permission } from "./api"
import { pluginPicture, type Picture } from "./bridge"
import { PROBE_MS, createLink } from "./link"

type P = Parameters<typeof pluginPicture>[0]["panes"][number]

const pane = (id: string, over: Partial<P> = {}): P => ({
  id,
  title: id,
  status: "working",
  mode: "—",
  agent: "claude-code",
  model: "claude-code",
  workspaceId: "nikcli",
  projectRoot: "C:/secret/nikcli",
  ...over,
})

const open = { name: "nikcli", root: "C:/secret/nikcli" }
const chordOk: Chord = { key: "p", ctrl: true, alt: false, shift: true, meta: false }
const msg = (over: Record<string, unknown>) => ({ v: 1, ...over })

interface Sent {
  type: string
  [key: string]: unknown
}

/** A link on a fake port: what it says lands in `sent`, what ADE is asked to do in `calls`, and the clock is the test's. */
function rig(granted: readonly Permission[], options: { panes?: P[]; decisions?: number; chordRuns?: boolean } = {}) {
  const sent: Sent[] = []
  const calls: string[] = []
  const ignored: string[] = []
  let panes = options.panes ?? [pane("a", { title: "Dario" }), pane("b", { title: "Lucia" })]
  let decisions = options.decisions ?? 2
  let now = 1000
  let previous: Picture | undefined
  const timers = new Map<number, { at: number; run: () => void }>()
  let next = 0
  let storage: unknown = null
  const link = createLink({
    port: { postMessage: (message) => sent.push(message as Sent), close: () => calls.push("close") },
    granted,
    hello: () => ({ locale: "it", theme: "dark", reducedMotion: false }),
    picture: () => {
      previous = pluginPicture({ panes, open, facts: () => ({}), decisions, now, salt: "s".repeat(32), ...(previous ? { previous } : {}) })
      return previous
    },
    focusPane: (paneId) => calls.push(`focus ${paneId}`),
    runChord: (chord) => {
      calls.push(`chord ${chord.key}`)
      return options.chordRuns ?? true
    },
    releaseFocus: () => calls.push("release"),
    storageGet: async () => storage,
    storageSet: async (json) => {
      storage = JSON.parse(json)
    },
    ignored: (reason) => ignored.push(reason),
    schedule: (run, ms) => {
      const id = next++
      timers.set(id, { at: now + ms, run })
      return () => void timers.delete(id)
    },
    now: () => now,
    onDead: () => calls.push("dead"),
    onReady: () => calls.push("ready"),
  })
  return {
    link,
    sent,
    calls,
    ignored,
    setPanes: (value: P[]) => (panes = value),
    setDecisions: (value: number) => (decisions = value),
    advance(ms: number) {
      now += ms
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) {
          timers.delete(id)
          timer.run()
        }
      }
    },
    /** Sends one message and lets the promises of the storage settle. */
    async say(body: Record<string, unknown>) {
      link.receive(msg(body))
      await Promise.resolve()
      await Promise.resolve()
    },
    replies: () => sent.filter((message) => message.type === "reply"),
    last: () => sent[sent.length - 1],
  }
}

const ALL: readonly Permission[] = PERMISSIONS

describe("hello and ready", () => {
  test("the port opens with a hello: the API, what was granted, language, theme and motion", () => {
    const { link, sent } = rig(["storage"])
    link.start()
    expect(sent).toEqual([
      { v: 1, type: "hello", api: 1, granted: ["storage"], locale: "it", theme: "dark", reducedMotion: false },
    ])
  })

  test("ready sends what was granted: sessions, projects and the count, each only if the plugin may", () => {
    const all = rig(ALL)
    all.link.receive(msg({ type: "ready" }))
    expect(all.sent.map((message) => message.type)).toEqual(["sessions.snapshot", "projects", "decisions.count"])
    const some = rig(["projects:read"])
    some.link.receive(msg({ type: "ready" }))
    expect(some.sent.map((message) => message.type)).toEqual(["projects"])
  })

  test("a plugin with no permission is sent nothing on ready: no sessions, no projects, not even a count", () => {
    const { link, sent, calls } = rig([])
    link.receive(msg({ type: "ready" }))
    expect(sent).toEqual([])
    expect(calls).toEqual(["ready"])
    expect(JSON.stringify(sent)).not.toMatch(/Dario|nikcli|paneId/)
  })
})

describe("sessions.snapshot: sessions:read", () => {
  test("granted: it answers with the sessions, titles and states, and no path", async () => {
    const { say, replies } = rig(["sessions:read"])
    await say({ type: "sessions.snapshot", id: 1 })
    const reply = replies()[0]!
    expect(reply).toMatchObject({ v: 1, type: "reply", id: 1, ok: true })
    const value = reply.value as { sessions: { title: string }[] }
    expect(value.sessions.map((session) => session.title)).toEqual(["Dario", "Lucia"])
    expect(JSON.stringify(reply)).not.toMatch(/secret|C:/)
  })

  test("denied: an error with the reason, and no data at all", async () => {
    const { say, replies, calls } = rig(ALL.filter((permission) => permission !== "sessions:read"))
    await say({ type: "sessions.snapshot", id: 1 })
    expect(replies()).toEqual([{ v: 1, type: "reply", id: 1, ok: false, error: "permesso mancante: sessions:read" }])
    expect(JSON.stringify(replies())).not.toMatch(/Dario|Lucia|paneId/)
    expect(calls).toEqual([])
  })

  test("changes arrive as events, and a new title as a whole snapshot", () => {
    const { link, sent, setPanes } = rig(["sessions:read"])
    link.receive(msg({ type: "ready" }))
    sent.length = 0
    setPanes([pane("a", { title: "Dario", status: "error" }), pane("b", { title: "Lucia" }), pane("c", { title: "Fabio" })])
    link.push()
    expect(sent.map((message) => (message.event as { type: string }).type)).toEqual(["open", "state"])
    sent.length = 0
    setPanes([pane("a", { title: "Rinominata", status: "error" }), pane("b", { title: "Lucia" }), pane("c", { title: "Fabio" })])
    link.push()
    expect(sent.map((message) => message.type)).toEqual(["sessions.snapshot"])
  })

  test("a plugin without sessions:read hears nothing of the sessions, whatever changes", () => {
    const { link, sent, setPanes } = rig(["projects:read"])
    link.receive(msg({ type: "ready" }))
    sent.length = 0
    setPanes([pane("a", { status: "error" }), pane("z", { title: "Nuova" })])
    link.push()
    expect(sent).toEqual([])
  })
})

describe("projects: projects:read", () => {
  test("granted: name and an opaque id, and the id has no path in it", async () => {
    const { say, replies } = rig(["projects:read"])
    await say({ type: "projects", id: 2 })
    const value = replies()[0]!.value as { id: string; name: string }[]
    expect(value).toHaveLength(1)
    expect(value[0]!.name).toBe("nikcli")
    expect(value[0]!.id).toMatch(/^p[0-9a-f]{16}$/)
    expect(JSON.stringify(replies())).not.toMatch(/secret|C:/)
  })

  test("denied: an error and no project", async () => {
    const { say, replies } = rig(["sessions:read"])
    await say({ type: "projects", id: 2 })
    expect(replies()).toEqual([{ v: 1, type: "reply", id: 2, ok: false, error: "permesso mancante: projects:read" }])
  })
})

describe("decisions.count: decisions:count", () => {
  test("granted: the count, and a change of it is pushed", async () => {
    const { say, replies, link, sent, setDecisions } = rig(["decisions:count"])
    await say({ type: "decisions.count", id: 3 })
    expect(replies()[0]).toMatchObject({ ok: true, value: 2 })
    link.receive(msg({ type: "ready" }))
    sent.length = 0
    setDecisions(5)
    link.push()
    expect(sent).toEqual([{ v: 1, type: "decisions.count", count: 5 }])
  })

  test("denied: an error, and no number", async () => {
    const { say, replies } = rig([])
    await say({ type: "decisions.count", id: 3 })
    expect(replies()).toEqual([{ v: 1, type: "reply", id: 3, ok: false, error: "permesso mancante: decisions:count" }])
  })
})

describe("pause and resume", () => {
  test("pause tells the plugin and silences the pushes; resume tells it and sends the picture as it is now", () => {
    const { link, sent, setPanes } = rig(["sessions:read"])
    link.receive(msg({ type: "ready" }))
    sent.length = 0
    link.pause()
    setPanes([pane("z", { title: "Nuova" })])
    link.push()
    expect(sent.map((message) => message.type)).toEqual(["pause"])
    link.resume()
    expect(sent.map((message) => message.type)).toEqual(["pause", "resume", "sessions.snapshot"])
    expect((sent[2]!.snapshot as { sessions: { title: string }[] }).sessions.map((s) => s.title)).toEqual(["Nuova"])
  })

  test("they need no permission, and a second pause or resume says nothing", () => {
    const { link, sent } = rig([])
    link.pause()
    link.pause()
    link.resume()
    link.resume()
    expect(sent.map((message) => message.type)).toEqual(["pause", "resume"])
  })

  test("a plugin that pauses while it is paused gets no picture on ready", () => {
    const { link, sent } = rig(["sessions:read"])
    link.pause()
    link.receive(msg({ type: "ready" }))
    expect(sent.map((message) => message.type)).toEqual(["pause"])
  })
})

describe("pane.focus: pane:focus, and only a pane the plugin was shown", () => {
  test("granted, for a session that was in what the plugin was shown: ADE focuses it", async () => {
    const { say, calls, replies } = rig(["pane:focus", "sessions:read"])
    await say({ type: "ready" })
    await say({ type: "pane.focus", id: 4, paneId: "a" })
    expect(calls).toContain("focus a")
    expect(replies()[0]).toMatchObject({ id: 4, ok: true })
  })

  test("an invented paneId is refused, and ADE does nothing", async () => {
    const { say, calls, replies } = rig(["pane:focus", "sessions:read"])
    await say({ type: "ready" })
    await say({ type: "pane.focus", id: 4, paneId: "inventata" })
    expect(calls).not.toContain("focus inventata")
    expect(replies()[0]).toMatchObject({ id: 4, ok: false })
    expect(replies()[0]!.error).toContain("sessione sconosciuta")
  })

  test("a session that has closed since is no longer one the plugin may focus", async () => {
    const { say, calls, link, setPanes } = rig(["pane:focus", "sessions:read"])
    await say({ type: "ready" })
    setPanes([pane("b", { title: "Lucia" })])
    link.push()
    await say({ type: "pane.focus", id: 5, paneId: "a" })
    expect(calls).not.toContain("focus a")
  })

  test("a plugin that was never shown sessions may focus none, even with the permission", async () => {
    const { say, calls, replies } = rig(["pane:focus"])
    await say({ type: "ready" })
    await say({ type: "pane.focus", id: 6, paneId: "a" })
    expect(calls).not.toContain("focus a")
    expect(replies()[0]).toMatchObject({ ok: false })
  })

  test("a count asked for does not make the sessions it never received into ones it may focus", async () => {
    const { say, calls } = rig(["pane:focus", "decisions:count"])
    await say({ type: "decisions.count", id: 1 })
    await say({ type: "pane.focus", id: 2, paneId: "a" })
    expect(calls).not.toContain("focus a")
  })

  test("denied: an error, and ADE does nothing", async () => {
    const { say, calls, replies } = rig(["sessions:read"])
    await say({ type: "ready" })
    await say({ type: "pane.focus", id: 7, paneId: "a" })
    expect(calls.filter((call) => call.startsWith("focus"))).toEqual([])
    expect(replies()[0]).toEqual({ v: 1, type: "reply", id: 7, ok: false, error: "permesso mancante: pane:focus" })
  })
})

describe("command.run: command:navigation", () => {
  test("granted: ADE is asked, and it says yes when the chord is navigation", async () => {
    const { say, calls, replies } = rig(["command:navigation"])
    await say({ type: "command.run", id: 8, chord: chordOk })
    expect(calls).toEqual(["chord p"])
    expect(replies()[0]).toMatchObject({ id: 8, ok: true })
  })

  test("a chord that is not navigation is refused with the reason", async () => {
    const { say, replies } = rig(["command:navigation"], { chordRuns: false })
    await say({ type: "command.run", id: 8, chord: chordOk })
    expect(replies()[0]).toMatchObject({ id: 8, ok: false })
    expect(replies()[0]!.error).toContain("navigazione")
  })

  test("denied: ADE is never asked", async () => {
    const { say, calls, replies } = rig(["storage"])
    await say({ type: "command.run", id: 8, chord: chordOk })
    expect(calls).toEqual([])
    expect(replies()[0]).toMatchObject({ ok: false, error: "permesso mancante: command:navigation" })
  })

  test("a malformed chord never reaches ADE", async () => {
    const { say, calls, replies } = rig(ALL)
    await say({ type: "command.run", id: 9, chord: { key: "p" } })
    expect(calls).toEqual([])
    expect(replies()[0]).toMatchObject({ id: 9, ok: false })
  })
})

describe("focus.release: no permission", () => {
  test("anyone may hand the focus back", async () => {
    const { say, calls, replies } = rig([])
    await say({ type: "focus.release", id: 10 })
    expect(calls).toEqual(["release"])
    expect(replies()[0]).toMatchObject({ id: 10, ok: true })
  })

  test("without an id it is done and nothing is said", async () => {
    const { say, calls, sent } = rig([])
    await say({ type: "focus.release" })
    expect(calls).toEqual(["release"])
    expect(sent).toEqual([])
  })
})

describe("storage.get and storage.set: storage", () => {
  test("granted: what was set comes back", async () => {
    const { say, replies } = rig(["storage"])
    await say({ type: "storage.get", id: 1 })
    expect(replies()[0]).toMatchObject({ ok: true, value: null })
    await say({ type: "storage.set", id: 2, value: { x: [1, 2] } })
    await say({ type: "storage.get", id: 3 })
    expect(replies().map((reply) => [reply.id, reply.ok, reply.value])).toEqual([
      [1, true, null],
      [2, true, null],
      [3, true, { x: [1, 2] }],
    ])
  })

  test("denied: errors, and the plugin's document is not read or written", async () => {
    const { say, replies } = rig(ALL.filter((permission) => permission !== "storage"))
    await say({ type: "storage.set", id: 1, value: { x: 1 } })
    await say({ type: "storage.get", id: 2 })
    expect(replies().map((reply) => [reply.ok, reply.error])).toEqual([
      [false, "permesso mancante: storage"],
      [false, "permesso mancante: storage"],
    ])
  })

  test("a value over 1 MB is refused before anything is written", async () => {
    const { say, replies } = rig(["storage"])
    await say({ type: "storage.set", id: 1, value: "a".repeat(MAX_STORAGE_BYTES) })
    expect(replies()[0]).toMatchObject({ ok: false })
    await say({ type: "storage.get", id: 2 })
    expect(replies()[1]).toMatchObject({ ok: true, value: null })
  })

  test("a failure of the native side is an error reply, not silence", async () => {
    const sent: Sent[] = []
    const link = createLink({
      port: { postMessage: (message) => sent.push(message as Sent), close() {} },
      granted: ["storage"],
      hello: () => ({ locale: "it", theme: "dark", reducedMotion: false }),
      picture: () => undefined,
      focusPane() {},
      runChord: () => false,
      releaseFocus() {},
      storageGet: async () => {
        throw new Error("disco pieno")
      },
      storageSet: async () => {
        throw new Error("disco pieno")
      },
      ignored() {},
      schedule: () => () => {},
      now: () => 0,
    })
    link.receive(msg({ type: "storage.get", id: 1 }))
    link.receive(msg({ type: "storage.set", id: 2, value: 1 }))
    await Promise.resolve()
    await Promise.resolve()
    expect(sent.map((message) => [message.id, message.ok, message.error])).toEqual([
      [1, false, "storage.get: disco pieno"],
      [2, false, "storage.set: disco pieno"],
    ])
  })
})

describe("what is malformed or unknown gets an error with the reason, and does nothing", () => {
  test("a malformed message: an error reply when it has an id, an error message when it has not", async () => {
    const { say, sent, calls } = rig(ALL)
    await say({ type: "pane.focus", id: 1, paneId: 5 })
    await say({ type: "pane.focus", paneId: 5 })
    await say({ type: "nope", id: 2 })
    expect(sent).toEqual([
      { v: 1, type: "reply", id: 1, ok: false, error: "pane.focus senza una sessione valida" },
      { v: 1, type: "error", error: "pane.focus senza una sessione valida" },
      { v: 1, type: "reply", id: 2, ok: false, error: "messaggio sconosciuto: nope" },
    ])
    expect(calls).toEqual([])
  })

  test("__proto__ and constructor are unknown messages", async () => {
    const { say, replies, calls } = rig(ALL)
    await say({ type: "__proto__", id: 1 })
    await say({ type: "constructor", id: 2 })
    expect(replies().map((reply) => reply.ok)).toEqual([false, false])
    expect(calls).toEqual([])
  })

  test("what is not an object at all is an error and nothing more", () => {
    const { link, sent, calls } = rig(ALL)
    for (const raw of [null, undefined, "ready", 3, [], new Uint8Array(4)]) link.receive(raw)
    expect(sent.every((message) => message.type === "error")).toBe(true)
    expect(calls).toEqual([])
  })

  test("every refusal is registered with its reason", async () => {
    const { say, ignored } = rig([])
    await say({ type: "projects", id: 1 })
    await say({ type: "nope", id: 2 })
    expect(ignored).toEqual(["permesso mancante: projects:read", "messaggio sconosciuto: nope"])
  })
})

describe("the ceiling of 50 messages a second", () => {
  test("over it, messages are dropped without an answer, and one warning is registered", async () => {
    const { link, sent, ignored } = rig(["decisions:count"])
    for (let i = 0; i < 80; i++) link.receive(msg({ type: "decisions.count", id: i }))
    await Promise.resolve()
    expect(sent.filter((message) => message.type === "reply")).toHaveLength(50)
    expect(ignored).toEqual(["troppi messaggi: oltre 50 al secondo si scartano"])
  })

  test("a flood of malformed messages is not answered one by one", () => {
    const { link, sent } = rig([])
    for (let i = 0; i < 500; i++) link.receive(msg({ type: "nope", id: i }))
    expect(sent).toHaveLength(50)
  })

  test("after a second the plugin is heard again", async () => {
    const { link, sent, advance } = rig(["decisions:count"])
    for (let i = 0; i < 60; i++) link.receive(msg({ type: "decisions.count", id: i }))
    advance(1000)
    link.receive(msg({ type: "decisions.count", id: 999 }))
    expect(sent.at(-1)).toMatchObject({ id: 999, ok: true })
  })
})

describe("the probe: a frame that navigated away loses its port", () => {
  test("a ping is answered by the live document, and the link stays", () => {
    const { link, sent, advance, calls } = rig([])
    link.probe()
    const ping = sent.at(-1)!
    expect(ping).toMatchObject({ type: "ping" })
    link.receive(msg({ type: "pong", id: ping.id }))
    advance(PROBE_MS * 2)
    expect(calls).not.toContain("close")
  })

  test("no answer in time: the port is closed and the panel is told", () => {
    const { link, advance, calls } = rig([])
    link.probe()
    advance(PROBE_MS)
    expect(calls).toEqual(["close", "dead"])
    link.receive(msg({ type: "ready" }))
    expect(calls).toEqual(["close", "dead"])
  })

  test("the answer to an old or invented ping does not count", () => {
    const { link, advance, calls } = rig([])
    link.probe()
    link.receive(msg({ type: "pong", id: 99 }))
    advance(PROBE_MS)
    expect(calls).toContain("dead")
  })

  test("a closed link says and does nothing", async () => {
    const { link, sent, say } = rig(ALL)
    link.close()
    await say({ type: "ready" })
    link.push()
    link.pause()
    expect(sent).toEqual([])
    expect(link.shown()).toBeUndefined()
  })
})
