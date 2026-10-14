import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  ECHO_MS,
  OUTPUT_CLAIM_MAX_MS,
  OUTPUT_WINDOW_MS,
  WORKING_WINDOWS,
  createOutputClaims,
  outputRun,
  outputSaysWorking,
  stampingInput,
  type OutputRun,
} from "./output-activity"
import { isFree } from "./mailbox"

/*
 * `output-activity.fixture.json`: the times, and nothing else, of the chunks six
 * real TUIs printed in a ConPTY on 2026-09-28, coalesced to one per 16 ms as
 * ADE's pty sender emits them, per phase:
 *   - `focus`, `resize`: at their prompt, a focus report and a resize (idle; a
 *     minute left alone printed nothing at all, so it has no entry);
 *   - `typing`: a prompt typed one key every 40 ms, the echo;
 *   - `working`: the first 20 s of a turn (Prime's includes a tool call).
 * Times are milliseconds from the start of the phase.
 */
const phases = JSON.parse(readFileSync(join(import.meta.dir, "output-activity.fixture.json"), "utf8")) as Record<
  string,
  Record<string, number[]>
>

/** Feeds a phase's chunks through the detector: the first time it says working, or undefined. */
function replay(times: number[], inputAt?: (t: number) => number | undefined): number | undefined {
  let run: OutputRun | undefined
  for (const t of times) {
    run = outputRun(run, t, inputAt?.(t))
    if (outputSaysWorking(run)) return t
  }
  return undefined
}

describe("output that says an agent without hooks is working (fix 5)", () => {
  test("a redraw is one burst; a run of windows is a turn", () => {
    let run = outputRun(undefined, 0, undefined)
    run = outputRun(run, 100, undefined)
    expect(run).toEqual({ window: 0, run: 1 })
    run = outputRun(run, OUTPUT_WINDOW_MS + 10, undefined)
    expect(outputSaysWorking(run)).toBe(false)
    run = outputRun(run, 2 * OUTPUT_WINDOW_MS + 10, undefined)
    expect(run?.run).toBe(WORKING_WINDOWS)
    expect(outputSaysWorking(run)).toBe(true)
  })

  test("an empty window starts the count again", () => {
    let run = outputRun(undefined, 0, undefined)
    run = outputRun(run, OUTPUT_WINDOW_MS, undefined)
    run = outputRun(run, 3 * OUTPUT_WINDOW_MS, undefined)
    expect(run?.run).toBe(1)
  })

  test("output right after a keystroke is its echo, and does not count", () => {
    expect(outputRun({ window: 1, run: 2 }, 1_000 + OUTPUT_WINDOW_MS, 1_000 + OUTPUT_WINDOW_MS - 10)).toBeUndefined()
    expect(outputRun(undefined, 5_000, 5_000 - ECHO_MS)).toEqual({ window: 10, run: 1 })
  })

  for (const [agent, recordedPhases] of Object.entries(phases)) {
    for (const phase of ["focus", "resize"]) {
      const times = recordedPhases[phase]
      if (!times) continue
      test(`${agent}: a ${phase} at the prompt is not taken for work`, () => {
        expect(replay(times)).toBeUndefined()
      })
    }
    if (recordedPhases.typing) {
      test(`${agent}: the echo of a prompt typed key by key is not taken for work`, () => {
        const keys = recordedPhases.typing!
        // One key every 40 ms from the start of the phase, until the last echo.
        const lastKey = Math.floor(keys[keys.length - 1]! / 40) * 40
        expect(replay(keys, (t) => Math.min(Math.floor(t / 40) * 40, lastKey))).toBeUndefined()
        // The same output with nobody typing would have been: the rule is the input, not luck.
        expect(replay(keys)).toBeDefined()
      })
    }
    if (recordedPhases.working) {
      test(`${agent}: a turn is seen within two seconds of its first output`, () => {
        const times = recordedPhases.working!
        const seen = replay(times)
        expect(seen).toBeDefined()
        expect(seen! - times[0]!).toBeLessThan(2_000)
      })
    }
  }

  test("every agent of the measurement is in the fixture", () => {
    expect(Object.keys(phases).sort()).toEqual(["agy", "grok", "kimi", "opencode", "pi", "prime"])
  })

  test("lint: an idle pane's output goes through the detector, and every spawn stamps its input", () => {
    const source = readFileSync(join(import.meta.dir, "..", "surface", "workbench.tsx"), "utf8")
    expect(source).toContain('else if (pane.status === "idle") noticeWorkFromOutput(pane)')
    // The local spawn and the ssh one: without the stamp every echo would count.
    expect(source.match(/stampingInput\(session, \(\) => lastInputAt\.set\(paneId, Date\.now\(\)\)\)/g)).toHaveLength(2)
    expect(source).toMatch(
      /const noticeWorkFromOutput = [\s\S]*?\(hooked\(pane\.id\) && activityOf\.has\(pane\.id\)\)\) return[\s\S]*?markWorking\(pane\.id\)/,
    )
  })

  test("the stamp is taken on every write and resize, and both still go through", () => {
    const written: string[] = []
    let stamps = 0
    const session = {
      write: (data: string) => void written.push(data),
      resize: (cols: number, rows: number) => void written.push(`${cols}x${rows}`),
    }
    const same = stampingInput(session, () => void stamps++)
    expect(same).toBe(session)
    session.write("a")
    session.write("\r")
    session.resize(80, 24)
    expect(written).toEqual(["a", "\r", "80x24"])
    expect(stamps).toBe(3)
  })
})

/*
 * 2026-10-14: after ADE restarted, the ragu session «Sol 6.1» showed `working` for three hours with its server idle
 * (every message complete, nothing pending): its TUI, resumed, kept repainting at ~7% CPU. Output was the only thing
 * that said «working», and a TUI that repaints without end is never quiet, so nothing ever said otherwise: the
 * status stayed, the mail waited for a free session that never came, and an Esc did not end a «turn» that was
 * only a spinner.
 */
describe("output alone is believed to be a turn only for so long (resumed TUI that repaints for ever)", () => {
  const PANE = "p13"

  test("a claim made by output alone expires, once, and the pane is then not read from its output again", () => {
    const claims = createOutputClaims()
    claims.noticed(PANE, 0)
    expect(claims.expire(PANE, OUTPUT_CLAIM_MAX_MS - 1)).toBe(false)
    expect(claims.quarantined(PANE)).toBe(false)
    expect(claims.expire(PANE, OUTPUT_CLAIM_MAX_MS)).toBe(true)
    expect(claims.quarantined(PANE)).toBe(true)
    // Nothing left to expire: the pane is idle and says so, whatever it goes on printing.
    expect(claims.expire(PANE, OUTPUT_CLAIM_MAX_MS * 5)).toBe(false)
  })

  test("a turn with evidence (a keystroke ADE saw, a delivery, a hook) is never expired by this rule", () => {
    const claims = createOutputClaims()
    claims.noticed(PANE, 0)
    claims.evidence(PANE)
    expect(claims.expire(PANE, OUTPUT_CLAIM_MAX_MS * 100)).toBe(false)
    expect(claims.quarantined(PANE)).toBe(false)
  })

  test("evidence lifts the quarantine: the next turn is read from output again", () => {
    const claims = createOutputClaims()
    claims.noticed(PANE, 0)
    claims.expire(PANE, OUTPUT_CLAIM_MAX_MS)
    expect(claims.quarantined(PANE)).toBe(true)
    claims.evidence(PANE)
    expect(claims.quarantined(PANE)).toBe(false)
    claims.noticed(PANE, OUTPUT_CLAIM_MAX_MS + 10)
    expect(claims.expire(PANE, OUTPUT_CLAIM_MAX_MS * 2 + 10)).toBe(true)
  })

  test("an interruption quarantines the pane at once, and drops any claim", () => {
    const claims = createOutputClaims()
    claims.noticed(PANE, 0)
    claims.quarantine(PANE)
    expect(claims.quarantined(PANE)).toBe(true)
    expect(claims.expire(PANE, OUTPUT_CLAIM_MAX_MS * 3)).toBe(false)
  })

  test("a pane that is closed or restarted starts clean", () => {
    const claims = createOutputClaims()
    claims.noticed(PANE, 0)
    claims.expire(PANE, OUTPUT_CLAIM_MAX_MS)
    claims.forget(PANE)
    expect(claims.quarantined(PANE)).toBe(false)
  })

  test("a quarantined pane is free for mail although it goes on printing; a question or a typed line still holds it", () => {
    const printing = { hooked: false, permissionPending: false, lastOutputAt: 10_000 }
    const now = 10_500
    expect(isFree(printing, now)).toBe(false)
    expect(isFree({ ...printing, quarantined: true }, now)).toBe(true)
    expect(isFree({ ...printing, quarantined: true, permissionPending: true }, now)).toBe(false)
    expect(isFree({ ...printing, quarantined: true, typing: true }, now)).toBe(false)
    // A hooked session's own word still decides: the quarantine is for the agents that say nothing.
    expect(isFree({ hooked: true, permissionPending: false, quarantined: true, activity: { state: "busy", at: now - 1_000 } }, now)).toBe(false)
  })

  test("lint: the workbench expires claims on every pass and quarantines on an interruption", () => {
    const source = readFileSync(join(import.meta.dir, "..", "surface", "workbench.tsx"), "utf8")
    expect(source).toContain("claims.expire(paneId, now)")
    expect(source).toContain("claims.quarantine(target.pane.id)")
    expect(source).toContain("claims.evidence(paneId)")
    expect(source).toContain("quarantined: claims.quarantined(paneId)")
  })
})
