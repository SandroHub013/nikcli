import { describe, expect, test } from "bun:test"
import {
  OPENING_QUIET_MS,
  OPENING_SETTLE_MS,
  OPENING_TIMEOUT_MS,
  bytesAfter,
  clockAfterMenu,
  decideOpening,
  drawsText,
  openingStep,
  screenDrawn,
  type OpeningBytes,
  type OpeningInput,
} from "./opening"

const at = (overrides: Partial<OpeningInput>): OpeningInput => ({
  startedAt: 0,
  now: 0,
  permissionPending: false,
  ...overrides,
})

describe("decideOpening", () => {
  test("waits while the process has said nothing at all", () => {
    // The old timer fired here regardless, which is how the text ended up in
    // a buffer nobody was reading yet.
    expect(decideOpening(at({ now: 900 }))).toBe("wait")
    expect(decideOpening(at({ now: 5_000 }))).toBe("wait")
    expect(decideOpening(at({ now: 22_000 }))).toBe("wait")
  })

  test("sends once the output has gone quiet", () => {
    const input = at({
      firstByteAt: 3_000,
      lastByteAt: 3_200,
      now: 3_200 + OPENING_QUIET_MS,
    })
    expect(decideOpening(input)).toBe("send")
  })

  test("does not send while bytes are still arriving", () => {
    const input = at({
      firstByteAt: 3_000,
      lastByteAt: 3_200,
      now: 3_200 + OPENING_QUIET_MS - 1,
    })
    expect(decideOpening(input)).toBe("wait")
  })

  /*
   * An Ink spinner repaints about every 80 ms and never stops, so waiting for
   * silence would wait forever on exactly the agents this feature exists for.
   */
  test("sends to a prompt that never goes quiet, once it has had time to draw", () => {
    const firstByteAt = 1_000
    let now = firstByteAt
    let decision = decideOpening(at({ firstByteAt, lastByteAt: now, now }))

    // Repaint every 80ms — never a quiet window.
    while (decision === "wait" && now - firstByteAt < 10_000) {
      now += 80
      decision = decideOpening(at({ firstByteAt, lastByteAt: now, now }))
    }

    expect(decision).toBe("send")
    expect(now - firstByteAt).toBeGreaterThanOrEqual(OPENING_SETTLE_MS)
    // And not much past it: an animated prompt must not cost seconds extra.
    expect(now - firstByteAt).toBeLessThan(OPENING_SETTLE_MS + 200)
  })

  /*
   * The failure the fixed timer actually caused. "Do you trust the files in
   * this folder?" is a yes/no prompt, and a task ending in Enter answers it.
   */
  test("never types while the session is holding a question", () => {
    const input = at({
      firstByteAt: 500,
      lastByteAt: 600,
      now: 10_000,
      permissionPending: true,
    })
    expect(decideOpening(input)).toBe("wait")
  })

  test("a question that outlives the deadline still holds the task: nothing is typed and nothing is given up", () => {
    const input = at({
      firstByteAt: 500,
      lastByteAt: 600,
      now: OPENING_TIMEOUT_MS * 10,
      permissionPending: true,
    })
    expect(decideOpening(input)).toBe("wait")
  })

  test("abandons a process that never said anything", () => {
    expect(decideOpening(at({ now: OPENING_TIMEOUT_MS }))).toBe("abandon")
  })

  /*
   * Every installed agent, at its measured time-to-first-output. The old
   * 900ms timer sent before the byte for five of these; none may regress.
   */
  test.each([
    ["claude", 60],
    ["pi", 493],
    ["agy", 664],
    ["codex", 683],
    ["opencode", 1093],
    ["kimi", 1377],
    ["ragu", 1912],
    ["gemini", 2398],
    ["hermes", 22954],
  ])("waits for %s, which first speaks at %ims", (_agent, firstByteAt) => {
    // Before the first byte: always wait, however long that takes.
    expect(decideOpening(at({ firstByteAt: undefined, now: firstByteAt - 1 }))).toBe("wait")

    // After it speaks and settles: send.
    expect(
      decideOpening(
        at({
          firstByteAt,
          lastByteAt: firstByteAt,
          now: firstByteAt + OPENING_QUIET_MS,
        }),
      ),
    ).toBe("send")
  })
})

/*
 * The poll of a first task, tick by tick, as the workbench drives it: the question stands until `answeredAt`, and the
 * clock starts again from the last pass that saw it (review of menu-posta, B1).
 */
function ticksAfterAnswer(answeredAt: number): string[] {
  const bytes: OpeningBytes = { firstByteAt: 100, lastByteAt: 200 }
  const decisions: string[] = []
  let menuAt: number | undefined
  for (let now = 100; now <= answeredAt + 1_000; now += 100) {
    const asked = now < answeredAt
    if (asked) menuAt = now
    const decision = decideOpening({
      ...clockAfterMenu({ startedAt: 0, ...bytes }, menuAt),
      now,
      permissionPending: asked,
    })
    if (now >= answeredAt) decisions.push(decision)
    if (decision !== "wait") break
  }
  return decisions
}

describe("a question answered late does not cost the task", () => {
  test("answered at 59 s, the task goes", () => {
    expect(ticksAfterAnswer(59_000).at(-1)).toBe("send")
  })

  test("answered at 61 s, past the opening's deadline, the task goes", () => {
    expect(ticksAfterAnswer(61_000)).not.toContain("abandon")
    expect(ticksAfterAnswer(61_000).at(-1)).toBe("send")
  })

  test("answered after ten minutes, the task goes", () => {
    expect(ticksAfterAnswer(600_000).at(-1)).toBe("send")
  })

  test("it goes once the screen has been quiet, not on the tick of the answer", () => {
    expect(ticksAfterAnswer(61_000)[0]).toBe("wait")
  })
})

/*
 * ConPTY speaks before the program does: its modes, the title and the cursor, about 100 ms after spawn (bytes of the
 * live test of 2026-11-02). Counted as the CLI having spoken, the task was typed 0.5 s after spawn on a blank screen,
 * into whatever the program opens on (review of menu-posta, B3).
 */
describe("the first byte is the first thing drawn", () => {
  const CONPTY = "\x1b[?9001h\x1b[?1004h\x1b[m\x1b]0;C:\\Windows\\System32\\cmd.exe\x07\x1b[?25h"
  const decide = (bytes: OpeningBytes, now: number) =>
    decideOpening({ startedAt: 0, ...bytes, now, permissionPending: false })

  test("ConPTY's own bytes, and nothing else, for as long as the program takes to start", () => {
    const bytes = bytesAfter({}, CONPTY, 100)
    expect(decide(bytes, 520)).toBe("wait")
    expect(decide(bytes, 12_000)).toBe("wait")
  })

  test("a blank screen, cursor moves and line ends are nothing drawn either", () => {
    expect(bytesAfter({}, "\x1b[2J\x1b[H\r\n  \r\n", 100)).toEqual({})
  })

  test("the first text starts the clock, and every byte after it keeps it going", () => {
    let bytes = bytesAfter({}, CONPTY, 100)
    bytes = bytesAfter(bytes, "FAKE AGENT ready", 12_000)
    expect(bytes).toEqual({ firstByteAt: 12_000, lastByteAt: 12_000 })
    bytes = bytesAfter(bytes, "\x1b[?25h", 12_100)
    expect(bytes).toEqual({ firstByteAt: 12_000, lastByteAt: 12_100 })
    expect(decide(bytes, 12_100 + OPENING_QUIET_MS - 1)).toBe("wait")
    expect(decide(bytes, 12_100 + OPENING_QUIET_MS)).toBe("send")
  })

  test("the limit that stays: a banner, 400 ms of quiet, then a menu", () => {
    const bytes = bytesAfter({}, "Loading...", 1_000)
    expect(decide(bytes, 1_000 + OPENING_QUIET_MS)).toBe("send")
  })
})

/*
 * A menu with a ticking status row never goes quiet. The note, the line to the parent and the trust dialog waited for
 * quiet, so nobody was told anything (review of menu-posta, N4).
 */
describe("when the screen counts as drawn", () => {
  test("quiet", () => {
    expect(screenDrawn({ firstByteAt: 1_000, lastByteAt: 1_200 }, 1_200 + OPENING_QUIET_MS)).toBe(true)
  })

  test("still painting, and not for long", () => {
    expect(screenDrawn({ firstByteAt: 1_000, lastByteAt: 1_200 }, 1_300)).toBe(false)
  })

  test("animated: past the settle it is as drawn as it gets", () => {
    const now = 1_000 + OPENING_SETTLE_MS
    expect(screenDrawn({ firstByteAt: 1_000, lastByteAt: now - 80 }, now)).toBe(true)
  })

  test("nothing drawn yet", () => {
    expect(screenDrawn({}, 100_000)).toBe(false)
  })
})

/*
 * What is no text, though `stripAnsi` leaves something of it: opentui's queries before its first frame (`+q4d73` and
 * `i=31337` are in its dll) and ncurses' sgr0. Read as text they started the clock, and the task went on a blank screen
 * for the CLIs ADE owns (re-review of menu-posta, R1).
 */
describe("what counts as drawn", () => {
  const CONPTY = "\x1b[?9001h\x1b[?1004h\x1b[m\x1b]0;C:\\Windows\\System32\\cmd.exe\x07\x1b[?25h"
  test.each([
    ["ragu's queries", "\x1b[?2026$p\x1bP+q4d73\x1b\\\x1b_Gi=31337,s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\\x1b[?u\x1b[c"],
    ["sgr0", "\x1b(B\x1b[m"],
    ["keypad and save cursor", "\x1b=\x1b>\x1b7\x1b8"],
    ["ConPTY's opening", CONPTY],
    ["a start of string, ended by a BEL", "\x1bX payload\x07"],
    ["a privacy message", "\x1b^ payload\x1b\\"],
    ["another charset", "\x1b)0"],
    ["a screen alignment", "\x1b#8"],
  ])("nothing: %s", (_name, chunk) => {
    expect(drawsText(chunk)).toBe(false)
  })

  test.each([
    ["real text ending in a CR", "Loading...\r"],
    ["real text", "FAKE AGENT ready"],
    ["a box", "╭──╮"],
    ["text after queries in one chunk", "\x1bP+q4d73\x1b\\Welcome"],
  ])("something: %s", (_name, chunk) => {
    expect(drawsText(chunk)).toBe(true)
  })
})

/*
 * With the clock at the first text the deadline can be reached, and a slow CLI lost its first task as it began to draw:
 * the pane went idle, the sender heard nothing, the text was kept nowhere (re-review of menu-posta, R2). It is said once,
 * in the pane and to the sender, and the poll goes on; it ends by itself when the process exits.
 */
describe("a session that says nothing past the deadline", () => {
  /** The poll of a first task, pass by pass, with text from `textAt` to `until`. What it did, and when. */
  function poll(textAt: number, until = textAt) {
    let bytes: OpeningBytes = {}
    let told = false
    const done: string[] = []
    for (let now = 100; now <= 300_000; now += 100) {
      if (now >= textAt && now <= until) bytes = bytesAfter(bytes, "FAKE AGENT ready", now)
      const step = openingStep(decideOpening({ startedAt: 0, ...bytes, now, permissionPending: false }), told)
      if (step === "wait") continue
      done.push(`${step} at ${now}`)
      if (step !== "tell") break
      told = true
    }
    return done
  }

  test("the text comes at 70 s: said once at the deadline, and the task goes", () => {
    expect(poll(70_000)).toEqual(["tell at 60000", "send at 70400"])
  })

  test("the text comes at 30 s: nothing to say", () => {
    expect(poll(30_000)).toEqual(["send at 30400"])
  })

  test("the program starts to draw just before the deadline, and goes on: the task goes at its settle", () => {
    expect(poll(59_800, 90_000)).toEqual(["tell at 60000", `send at ${59_800 + OPENING_SETTLE_MS}`])
  })

  test("no text ever: said once, and no task is typed", () => {
    expect(poll(400_000)).toEqual(["tell at 60000"])
  })
})
