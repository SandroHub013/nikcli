import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { codeOf } from "../test-support/source-text"
import { formatOpeningDropped } from "./mailbox"
import { workbenchSource } from "../test-support/workbench-source"
import {
  OPENING_QUIET_MS,
  OPENING_SETTLE_MS,
  OPENING_TIMEOUT_MS,
  bytesAfter,
  clockAfterMenu,
  decideOpening,
  drawsText,
  enterIsUsersLine,
  openingDropReason,
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

/*
 * Live test 11: an agent's box read `draft` at rest, so the opening waited; the user typed and sent a line, the box read
 * `ready` in the middle of the turn, and ADE typed 1922 characters into the agent while it worked. Ready is not leave to type.
 */
describe("an opening that is dropped", () => {
  const settled = { firstByteAt: 3_000, lastByteAt: 3_200, now: 10_000 }

  test("nothing happened: the normal send", () => {
    expect(decideOpening(at({ ...settled }))).toBe("send")
    expect(decideOpening(at({ ...settled, userSpoke: false, requestGone: false }))).toBe("send")
  })

  test("a line of the user's, sent since the start: dropped, on a screen that reads ready", () => {
    expect(decideOpening(at({ ...settled, userSpoke: true }))).toBe("drop")
  })

  test("a request cancelled: dropped, on a screen that reads ready", () => {
    expect(decideOpening(at({ ...settled, requestGone: true }))).toBe("drop")
  })

  test("dropped before anything else: a question standing, a silent process, a late deadline", () => {
    expect(decideOpening(at({ ...settled, userSpoke: true, permissionPending: true }))).toBe("drop")
    expect(decideOpening(at({ now: 900, userSpoke: true }))).toBe("drop")
    expect(decideOpening(at({ now: OPENING_TIMEOUT_MS * 2, requestGone: true }))).toBe("drop")
  })

  test("the reason names the user first, then the request; nothing when neither", () => {
    expect(openingDropReason({ userSpoke: true, requestGone: true })).toBe("user")
    expect(openingDropReason({ requestGone: true })).toBe("request")
    expect(openingDropReason({})).toBeUndefined()
  })

  test("the sender is told plainly that the user wrote first, and how to send the task again", () => {
    const told = formatOpeningDropped("r1", undefined)
    expect(told).toContain("r1")
    expect(told).toContain("non è partita")
    expect(told).toContain("l'utente ha scritto per primo")
    expect(told).toContain("mandalo di nuovo")
  })
})

/*
 * Whose line an Enter is. A login code in a startup dialog or a «1» to a menu is for the window, and the opening stays; the
 * line of live test 11 is for the agent's own box, and the opening goes. Only a detector's yes counts as a window: a screen
 * that reads nothing is no proof, because it can lag behind xterm.
 */
describe("an Enter that is, or is not, the user speaking", () => {
  const enter = (over: Partial<Parameters<typeof enterIsUsersLine>[0]>) =>
    enterIsUsersLine({ sendsLine: true, box: "none", windowKnown: false, ...over })

  test("a login code typed in a startup dialog that is recognised: not the user speaking, so the opening stays", () => {
    const spoke = enter({ box: "none", windowKnown: true })
    expect(spoke).toBe(false)
    expect(decideOpening(at({ firstByteAt: 3_000, lastByteAt: 3_200, now: 10_000, userSpoke: spoke }))).toBe("send")
  })

  test("a «1» sent to a recognised menu, on an agent whose box is not known: the opening stays", () => {
    const spoke = enter({ box: undefined, windowKnown: true })
    expect(spoke).toBe(false)
    expect(decideOpening(at({ firstByteAt: 3_000, lastByteAt: 3_200, now: 10_000, userSpoke: spoke }))).toBe("send")
  })

  test("the sequence of test 11: agy idle with its Auto mode line, the user types a message and Enter: dropped", () => {
    // The box reads draft at rest, so it is the agent's box that gets the Enter, whatever else a detector says.
    for (const windowKnown of [false, true]) {
      const spoke = enter({ box: "draft", windowKnown })
      expect(spoke).toBe(true)
      // Two and a half seconds later the box reads ready in the middle of the turn: still dropped.
      expect(decideOpening(at({ firstByteAt: 3_000, lastByteAt: 3_200, now: 10_000, userSpoke: spoke }))).toBe("drop")
    }
    expect(enter({ box: "ready" })).toBe(true)
  })

  test("a screen that reads nothing is no proof of a window: a real line sent then still counts", () => {
    expect(enter({ box: "none", windowKnown: false })).toBe(true)
    expect(enter({ box: undefined, windowKnown: false })).toBe(true)
  })

  test("an Enter that sent nothing is never the user speaking", () => {
    expect(enter({ sendsLine: false, box: "draft" })).toBe(false)
    expect(enter({ sendsLine: false, box: "none" })).toBe(false)
  })
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
      const step = openingStep(decideOpening({ startedAt: 0, ...bytes, now, permissionPending: false }), told, bytes)
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

  test("the program starts to draw just before the deadline, and goes on: nothing to say, and the task goes at its settle", () => {
    expect(poll(59_800, 90_000)).toEqual([`send at ${59_800 + OPENING_SETTLE_MS}`])
  })

  test("the program's first text comes just before the deadline, and stops: nothing to say", () => {
    expect(poll(59_800)).toEqual([`send at ${59_800 + OPENING_QUIET_MS}`])
  })

  test("no text ever: said once, and no task is typed", () => {
    expect(poll(400_000)).toEqual(["tell at 60000"])
  })
})

describe("lint: the opening poll drops what the user or a cancelled request has overtaken", () => {
  const source = codeOf(workbenchSource())
  const between = (from: string, to: string) => {
    const start = source.indexOf(codeOf(from))
    expect(start).toBeGreaterThanOrEqual(0)
    const end = source.indexOf(codeOf(to), start)
    expect(end).toBeGreaterThan(start)
    return source.slice(start, end)
  }
  const poll = between("const poll = setInterval(() => {", "openingPolls.add(poll)")

  test("the poll goes through decideOpening for the drop, before the trust dialog's Enter and before any typing", () => {
    const asked = poll.indexOf(codeOf("decideOpening({ startedAt, now: Date.now(), permissionPending: false, ...dropFields }) === \"drop\""))
    expect(asked).toBeGreaterThanOrEqual(0)
    expect(poll).toContain(codeOf("userSpoke: (userSpokeAt.get(paneId) ?? 0) >= startedAt"))
    expect(poll).toContain(codeOf("requestGone: spawnId !== undefined && !openRequests.has(spawnId)"))
    expect(asked).toBeLessThan(poll.indexOf(codeOf("session.write(")))
    expect(asked).toBeLessThan(poll.indexOf(codeOf("withIntro(agentId, task)")))
  })

  test("a drop clears the pane's task, so a restart of ADE or Riprendi does not type it again", () => {
    const dropped = between("=== \"drop\") {", "if (silenceTold && openingBytes.firstByteAt !== undefined) {")
    expect(dropped).toContain(codeOf("updatePane(w, paneId, { task: \"\" })"))
  })

  test("a drop leaves the pane's state alone over a window still on screen", () => {
    const dropped = between("=== \"drop\") {", "if (silenceTold && openingBytes.firstByteAt !== undefined) {")
    expect(dropped).toContain(codeOf("if (dropReason === \"request\" && !trustSeen && !menuTold && !questionOpen(paneId))"))
  })

  test("a drop stops the poll, says why in the pane, closes the request for its sender, and types nothing", () => {
    const dropped = between("=== \"drop\") {", "if (silenceTold && openingBytes.firstByteAt !== undefined) {")
    expect(dropped).toContain(codeOf("stopOpeningPoll(poll)"))
    expect(dropped).toContain(codeOf("tellPane(paneId, t(dropReason === \"user\" ? \"task.droppedUser\" : \"task.droppedRequest\"))"))
    expect(dropped).toContain(codeOf("tellSender(open.from, said, { lost: true })"))
    expect(dropped).toContain(codeOf("settle(host, open.id, said)"))
    expect(dropped).toContain(codeOf("return"))
    for (const typing of ["typeLine", "typeOpening", "deliverText", "session.write", "withIntro"]) {
      expect(dropped).not.toContain(codeOf(typing))
    }
  })

  test("the request is taken before the first await that follows the spawn, so a cancel during the awaits still counts", () => {
    const start = between("const start = running.beginStart(paneId)", "if (starting.typesTask) {")
    expect(start.indexOf(codeOf("constspawnId=[...openRequests.values()]"))).toBeGreaterThan(start.indexOf(codeOf("awaitgetHost()")))
    expect(start.indexOf(codeOf("constspawnId"))).toBeLessThan(start.indexOf(codeOf("awaithost.assignedSecrets")))
  })

  test("the cancel note is not held for an agent whose opening has not been typed", () => {
    const cancel = between("await settle(host, request.id, `[ade-msg] richiesta ${request.id} annullata`)", "await answer(`ok: richiesta")
    expect(cancel).toContain(codeOf("if (running.has(request.to) && !openingWaiting(request.to))"))
    expect(between("const openingPanes = new Map", "onCleanup(() => {")).toContain(codeOf("openingPanes.delete(poll)"))
    expect(poll + source.slice(source.indexOf(codeOf("}, 100)openingPolls.add(poll)")))).toContain(codeOf("openingPanes.set(poll, paneId)"))
  })

  test("the user's line is counted from the keys and the screen: a positive window does not count, the composer goes the same way", () => {
    const submitted = between("const turnSubmitted = (", "const promptAnswered")
    expect(submitted).toContain(
      codeOf("enterIsUsersLine({ sendsLine: line, box: composerNow(paneId), windowKnown: questionOpen(paneId) || trustDialogUp(paneId) })"),
    )
    expect(submitted).toContain(codeOf("userSpokeAt.set(paneId, Date.now())"))
    const renderer = codeOf(readFileSync(new URL("../surface/pane-renderer.tsx", import.meta.url), "utf8"))
    const counted = renderer.indexOf(codeOf("const sendsLine = submitsLine(deps.records.typed.get(current().id), data)"))
    expect(counted).toBeGreaterThanOrEqual(0)
    // Before the key is added to the count, or an Enter would always find the line it has just emptied.
    expect(counted).toBeLessThan(renderer.indexOf(codeOf("deps.records.typed.update(current().id, (line) => typedAfter(line, data")))
    expect(renderer).toContain(codeOf("deps.turnSubmitted(current().id, sendsLine)"))
  })
})
