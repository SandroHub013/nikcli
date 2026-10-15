import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  createSoundPolicy,
  IDLE_SETTLE_MS,
  rootSessionID,
  SOUND_MIN_GAP_MS,
  SOUND_SCALE,
} from "@tui/util/sound-policy"

/*
 * «Notifiche una dopo l'altra». The server publishes `session.idle` each time a session's status goes back to idle:
 * the main session, each subagent's child session (they run the same prompt loop and end in PromptState.finish), and
 * a cancel on a session that was already idle. app.tsx rang a pulse on every one of them, and the pulses rotate
 * pulse-a/-b/-c, so they sounded like a tune. These tests replay the events of real turns, with no player at all
 * (`play` is a counter), against the old handlers and the policy that replaced them.
 */
type Ev =
  | { at: number; type: "status"; session: string; status: "busy" | "retry" | "idle" }
  | { at: number; type: "idle"; session: string }
  | { at: number; type: "permission"; session: string; id: string }

const PARENT: Record<string, string | undefined> = { root: undefined, c1: "root", c2: "root", other: undefined }

/** What app.tsx did before: a pulse for every event, whoever it was for. */
function oldPulses(events: Ev[]) {
  return events.filter((e) => e.type === "idle" || e.type === "permission").length
}

function replay(events: Ev[], opts: { displayed?: string; muted?: boolean } = {}) {
  let now = 0
  let timers: Array<{ at: number; fn: () => void; live: boolean }> = []
  const played: Array<{ at: number; scale: number }> = []
  const policy = createSoundPolicy({
    now: () => now,
    setTimer: (fn, ms) => {
      const timer = { at: now + ms, fn, live: true }
      timers.push(timer)
      return timer
    },
    clearTimer: (handle) => {
      ;(handle as { live: boolean }).live = false
    },
    displayed: () => ("displayed" in opts ? opts.displayed : "root"),
    rootOf: (id) => rootSessionID(id, (x) => PARENT[x]),
    muted: () => opts.muted === true,
    play: (scale) => played.push({ at: now, scale }),
  })
  const advance = (to: number) => {
    for (;;) {
      const due = timers.filter((t) => t.live && t.at <= to).sort((a, b) => a.at - b.at)[0]
      if (!due) break
      due.live = false
      now = due.at
      due.fn()
    }
    now = to
  }
  for (const e of events) {
    advance(e.at)
    if (e.type === "status") policy.status(e.session, e.status)
    else if (e.type === "idle") policy.idle(e.session)
    else policy.permission(e.id, e.session)
  }
  advance(events.at(-1)!.at + 60_000)
  policy.dispose()
  return played
}

const turnWithSubagents: Ev[] = [
  { at: 0, type: "status", session: "root", status: "busy" },
  { at: 100, type: "status", session: "c1", status: "busy" },
  { at: 150, type: "status", session: "c2", status: "busy" },
  { at: 4000, type: "idle", session: "c1" },
  { at: 4300, type: "idle", session: "c2" },
  { at: 9000, type: "idle", session: "root" },
]

describe("a turn with two subagents", () => {
  test("rang three times before (one per session), once now, for the main session", () => {
    expect(oldPulses(turnWithSubagents)).toBe(3)
    const played = replay(turnWithSubagents)
    expect(played).toHaveLength(1)
    expect(played[0]!.scale).toBe(SOUND_SCALE.idle)
    expect(played[0]!.at).toBe(9000 + IDLE_SETTLE_MS)
  })

  test("a child session never rings, even when it is the only one that ends", () => {
    expect(replay(turnWithSubagents.filter((e) => e.type === "status" || e.session !== "root"))).toHaveLength(0)
  })
})

describe("idle rings at the end of a real turn, once", () => {
  test("a retry and an auto-continue inside the turn do not ring in between", () => {
    const events: Ev[] = [
      { at: 0, type: "status", session: "root", status: "busy" },
      { at: 2000, type: "status", session: "root", status: "retry" },
      { at: 5000, type: "idle", session: "root" },
      { at: 5400, type: "status", session: "root", status: "busy" },
      { at: 12000, type: "idle", session: "root" },
    ]
    expect(oldPulses(events)).toBe(2)
    const played = replay(events)
    expect(played).toHaveLength(1)
    expect(played[0]!.at).toBe(12000 + IDLE_SETTLE_MS)
  })

  test("a cancel on a session that was already idle is not the end of a turn", () => {
    const events: Ev[] = [
      { at: 0, type: "status", session: "root", status: "busy" },
      { at: 3000, type: "idle", session: "root" },
      { at: 20000, type: "idle", session: "root" },
    ]
    expect(oldPulses(events)).toBe(2)
    expect(replay(events)).toHaveLength(1)
  })

  test("an idle for a session that was never seen busy is ignored", () => {
    expect(replay([{ at: 0, type: "idle", session: "root" }])).toHaveLength(0)
  })

  test("a session the TUI is not showing does not ring", () => {
    const events: Ev[] = [
      { at: 0, type: "status", session: "other", status: "busy" },
      { at: 3000, type: "idle", session: "other" },
    ]
    expect(replay(events)).toHaveLength(0)
    expect(replay(events, { displayed: undefined })).toHaveLength(0)
  })

  test("a muted TUI (sound off, or looking at ragu) rings nothing", () => {
    expect(replay(turnWithSubagents, { muted: true })).toHaveLength(0)
  })
})

describe("a permission rings once", () => {
  test("the same request announced three times rings once", () => {
    const events: Ev[] = [
      { at: 0, type: "permission", session: "root", id: "p1" },
      { at: 5000, type: "permission", session: "root", id: "p1" },
      { at: 9000, type: "permission", session: "root", id: "p1" },
    ]
    expect(oldPulses(events)).toBe(3)
    const played = replay(events)
    expect(played).toHaveLength(1)
    expect(played[0]!.scale).toBe(SOUND_SCALE.permission)
  })

  test("a subagent's request still rings (someone has to answer it), another session's does not", () => {
    expect(replay([{ at: 0, type: "permission", session: "c1", id: "p2" }])).toHaveLength(1)
    expect(replay([{ at: 0, type: "permission", session: "other", id: "p3" }])).toHaveLength(0)
  })
})

describe("one sound every few seconds, at most", () => {
  test("two requests inside the gap ring once; the second rings when asked again after it", () => {
    const events: Ev[] = [
      { at: 0, type: "permission", session: "root", id: "a" },
      { at: 500, type: "permission", session: "root", id: "b" },
      { at: SOUND_MIN_GAP_MS + 500, type: "permission", session: "root", id: "b" },
    ]
    const played = replay(events)
    expect(played.map((p) => p.at)).toEqual([0, SOUND_MIN_GAP_MS + 500])
  })

  test("a turn that ends right after a permission was answered does not ring on top of it", () => {
    const events: Ev[] = [
      { at: 0, type: "status", session: "root", status: "busy" },
      { at: 100, type: "permission", session: "root", id: "a" },
      { at: 200, type: "idle", session: "root" },
    ]
    expect(replay(events)).toHaveLength(1)
  })
})

describe("rootSessionID", () => {
  test("walks to the top, and survives a loop", () => {
    expect(rootSessionID("c1", (id) => PARENT[id])).toBe("root")
    expect(rootSessionID("root", (id) => PARENT[id])).toBe("root")
    const loop: Record<string, string> = { a: "b", b: "a" }
    expect(["a", "b"]).toContain(rootSessionID("a", (id) => loop[id]))
  })
})

describe("app.tsx", () => {
  const app = readFileSync(join(import.meta.dir, "../../../tui/src/app.tsx"), "utf8")

  test("never calls Sound.pulse from an event handler, only through the policy", () => {
    expect(app.match(/Sound\.pulse\(/g)).toHaveLength(1)
    expect(app).toContain("play: (scale) => Sound.pulse(scale)")
    expect(app).toContain("soundPolicy.idle(evt.properties.sessionID)")
    expect(app).toContain("soundPolicy.permission(evt.properties.id, evt.properties.sessionID)")
    expect(app).toContain('sdk.event.on("session.status"')
  })
})
