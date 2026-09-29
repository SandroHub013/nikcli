import { describe, expect, test } from "bun:test"
import { PROBE_MS, createLink } from "./link"
import { ALLOWLIST, type Command, type Snapshot, type ToWorld } from "./protocol"

const agent = (paneId: string, state: Snapshot["agents"][number]["state"] = "work", title = paneId) => ({
  paneId,
  title,
  kind: "claude-code",
  shop: "s1",
  state,
  since: 1,
  look: { body: 0, palette: 0 },
})

const picture = (over: Partial<Snapshot> = {}): Snapshot => ({
  at: 1,
  shops: [{ id: "s1", name: "nikcli" }],
  agents: [agent("n1"), agent("n2")],
  waiting: { decisions: 0 },
  ...over,
})

function rig(initial: Snapshot | null = picture()) {
  const sent: ToWorld[] = []
  const ran: Command[] = []
  const asked: Command[] = []
  const ignored: string[] = []
  let now: Snapshot | undefined = initial ?? undefined
  let closed = false
  let dead = 0
  const approvals: (() => void)[] = []
  const timers = new Map<number, { at: number; run: () => void }>()
  let clock = 0
  let nextTimer = 0
  const link = createLink({
    port: { postMessage: (message) => void sent.push(message), close: () => void (closed = true) },
    picture: () => now,
    run: (command) => void ran.push(command),
    ask: (command, approve) => {
      asked.push(command)
      approvals.push(approve)
    },
    ignored: (reason) => void ignored.push(reason),
    schedule: (run, ms) => {
      const id = nextTimer++
      timers.set(id, { at: clock + ms, run })
      return () => void timers.delete(id)
    },
    onDead: () => void dead++,
  })
  return {
    advance: (ms: number) => {
      clock += ms
      for (const [id, timer] of [...timers]) {
        if (timer.at <= clock) {
          timers.delete(id)
          timer.run()
        }
      }
    },
    dead: () => dead,
    timers: () => timers.size,
    link,
    sent,
    ran,
    asked,
    ignored,
    approvals,
    closed: () => closed,
    set: (next: Snapshot | undefined) => void (now = next),
  }
}

describe("ADE's end of the channel", () => {
  test("the world gets the whole picture when it says it is ready, and not before", () => {
    const { link, sent } = rig()
    link.push()
    expect(sent).toEqual([])
    link.receive({ type: "ready" })
    expect(sent).toEqual([{ type: "snapshot", snapshot: picture() }])
  })

  test("after that only what changed goes across", () => {
    const { link, sent, set } = rig()
    link.receive({ type: "ready" })
    set(picture({ at: 2, agents: [agent("n1", "err"), agent("n2"), agent("n3")] }))
    link.push()
    expect(sent.slice(1).map((message) => (message.type === "event" ? message.event.type : message.type))).toEqual([
      "agent-spawn",
      "state",
    ])
    // Nothing new, nothing sent.
    link.push()
    expect(sent).toHaveLength(3)
  })

  test("a title that changed is not an event: the whole picture is sent again", () => {
    const { link, sent, set } = rig()
    link.receive({ type: "ready" })
    set(picture({ agents: [agent("n1", "work", "Dario"), agent("n2")] }))
    link.push()
    expect(sent).toHaveLength(2)
    expect(sent[1]).toMatchObject({ type: "snapshot" })
    expect((sent[1] as { snapshot: Snapshot }).snapshot.agents[0]!.title).toBe("Dario")
  })

  test("while paused nothing is sent; on resume the world is told and gets the picture as it is then", () => {
    const { link, sent, set } = rig()
    link.receive({ type: "ready" })
    link.pause()
    set(picture({ agents: [agent("n1", "err")] }))
    link.push()
    expect(sent.map((message) => message.type)).toEqual(["snapshot", "pause"])
    link.resume()
    expect(sent.map((message) => message.type)).toEqual(["snapshot", "pause", "resume", "snapshot"])
    expect((sent[3] as { snapshot: Snapshot }).snapshot.agents).toHaveLength(1)
  })

  test("a world that became ready while paused is shown the picture when it resumes", () => {
    const { link, sent } = rig()
    link.pause()
    link.receive({ type: "ready" })
    expect(sent.map((message) => message.type)).toEqual(["pause"])
    link.resume()
    expect(sent.map((message) => message.type)).toEqual(["pause", "resume", "snapshot"])
  })

  test("pausing twice or resuming when running says nothing", () => {
    const { link, sent } = rig()
    link.resume()
    link.pause()
    link.pause()
    expect(sent.map((message) => message.type)).toEqual(["pause"])
  })

  test("with no picture there is nothing to send", () => {
    const { link, sent } = rig(null)
    link.receive({ type: "ready" })
    expect(sent).toEqual([])
    expect(link.shown()).toBeUndefined()
  })
})

describe("a command from the world", () => {
  test("one on the allowlist, about something the world was shown, runs", () => {
    const { link, ran, ignored } = rig()
    link.receive({ type: "ready" })
    link.receive({ type: "command", command: { cmd: "open-session", paneId: "n2" } })
    link.receive({ type: "command", command: { cmd: "focus-project", project: "s1" } })
    link.receive({ type: "command", command: { cmd: "release-focus" } })
    expect(ran).toEqual([
      { cmd: "open-session", paneId: "n2" },
      { cmd: "focus-project", project: "s1" },
      { cmd: "release-focus" },
    ])
    expect(ignored).toEqual([])
  })

  test("an id that is not on the allowlist is ignored and registered, and nothing runs", () => {
    const { link, ran, ignored } = rig()
    link.receive({ type: "ready" })
    link.receive({ type: "command", command: { cmd: "close-session", paneId: "n1" } })
    link.receive({ type: "command", command: { cmd: "constructor" } })
    link.receive({ type: "command", command: "open-session" })
    expect(ran).toEqual([])
    expect(ignored).toEqual([
      "comando sconosciuto: close-session",
      "comando sconosciuto: constructor",
      "il comando non è un oggetto",
    ])
  })

  test("a session the world was never shown is ignored, even with a well formed command", () => {
    const { link, ran, ignored, set } = rig()
    link.receive({ type: "ready" })
    // n3 appears in ADE but the world has not been sent it yet.
    set(picture({ agents: [agent("n1"), agent("n2"), agent("n3")] }))
    link.receive({ type: "command", command: { cmd: "open-session", paneId: "n3" } })
    expect(ran).toEqual([])
    expect(ignored[0]).toContain("sessione sconosciuta")
    link.push()
    link.receive({ type: "command", command: { cmd: "open-session", paneId: "n3" } })
    expect(ran).toEqual([{ cmd: "open-session", paneId: "n3" }])
  })

  test("before it has been shown anything, the world can name nothing", () => {
    const { link, ran, ignored } = rig()
    link.receive({ type: "command", command: { cmd: "open-session", paneId: "n1" } })
    expect(ran).toEqual([])
    expect(ignored).toHaveLength(1)
  })

  test("a chord with no modifier is ignored; one with Ctrl runs", () => {
    const { link, ran, ignored } = rig()
    link.receive({ type: "command", command: { cmd: "chord", key: "w", ctrl: false, alt: false, shift: false, meta: false } })
    expect(ran).toEqual([])
    expect(ignored).toEqual(["chord senza Ctrl, Alt o Meta"])
    link.receive({ type: "command", command: { cmd: "chord", key: "k", ctrl: true, alt: false, shift: false, meta: false } })
    expect(ran).toHaveLength(1)
  })

  test("anything that is not a message of the protocol is ignored", () => {
    const { link, ran, ignored } = rig()
    for (const data of [null, undefined, "ready", 4, { type: "snapshot" }, { type: "eval" }]) link.receive(data)
    expect(ran).toEqual([])
    expect(ignored).toHaveLength(6)
  })

  test("after the link is closed nothing more is heard or sent", () => {
    const { link, sent, ran, closed } = rig()
    link.receive({ type: "ready" })
    link.close()
    expect(closed()).toBe(true)
    link.receive({ type: "command", command: { cmd: "release-focus" } })
    link.push()
    link.pause()
    expect(ran).toEqual([])
    expect(sent).toHaveLength(1)
  })

  test("a command that changes something waits for the user's yes, and runs only on it", () => {
    const table = ALLOWLIST as Record<string, { confirm: boolean }>
    const original = table["open-session"]!.confirm
    table["open-session"]!.confirm = true
    try {
      const { link, ran, asked, approvals } = rig()
      link.receive({ type: "ready" })
      link.receive({ type: "command", command: { cmd: "open-session", paneId: "n1" } })
      expect(asked).toEqual([{ cmd: "open-session", paneId: "n1" }])
      expect(ran).toEqual([])
      approvals[0]!()
      expect(ran).toEqual([{ cmd: "open-session", paneId: "n1" }])
    } finally {
      table["open-session"]!.confirm = original
    }
  })
})

describe("a navigation of the frame closes the port: the probe", () => {
  const pings = (sent: ToWorld[]) => sent.filter((message) => message.type === "ping") as { type: "ping"; id: number }[]

  test("a document that is still there answers, and the link stays", () => {
    const { link, sent, advance, dead, closed, timers } = rig()
    link.receive({ type: "ready" })
    link.probe()
    const [ping] = pings(sent)
    expect(ping).toBeDefined()
    link.receive({ type: "pong", id: ping!.id })
    expect(timers()).toBe(0)
    advance(PROBE_MS * 3)
    expect([dead(), closed()]).toEqual([0, false])
    link.pause()
    expect(sent.at(-1)).toEqual({ type: "pause" })
  })

  test("a frame that went somewhere else answers nothing: the port is closed after the wait", () => {
    const { link, sent, advance, dead, closed, ran } = rig()
    link.receive({ type: "ready" })
    link.probe()
    advance(PROBE_MS - 1)
    expect([dead(), closed()]).toEqual([0, false])
    advance(1)
    expect([dead(), closed()]).toEqual([1, true])
    // Nothing more is heard from it, or sent to it.
    const before = sent.length
    link.receive({ type: "command", command: { cmd: "release-focus" } })
    link.push()
    link.pause()
    expect(ran).toEqual([])
    expect(sent).toHaveLength(before)
  })

  test("an answer to an older or an invented probe does not save the link", () => {
    const { link, sent, advance, closed } = rig()
    link.receive({ type: "ready" })
    link.probe()
    const first = pings(sent)[0]!.id
    link.probe()
    const second = pings(sent)[1]!.id
    expect(second).not.toBe(first)
    link.receive({ type: "pong", id: first })
    link.receive({ type: "pong", id: 999 })
    advance(PROBE_MS)
    expect(closed()).toBe(true)
  })

  test("the answer to the probe that is waiting is enough, even after an older one was superseded", () => {
    const { link, sent, advance, closed } = rig()
    link.receive({ type: "ready" })
    link.probe()
    link.probe()
    link.receive({ type: "pong", id: pings(sent)[1]!.id })
    advance(PROBE_MS * 2)
    expect(closed()).toBe(false)
  })

  test("a link that is already closed is not probed, and closing on purpose leaves no clock", () => {
    const { link, sent, timers } = rig()
    link.receive({ type: "ready" })
    link.probe()
    expect(timers()).toBe(1)
    link.close()
    expect(timers()).toBe(0)
    link.probe()
    expect(pings(sent)).toHaveLength(1)
  })
})
