import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  ECHO_MS,
  OUTPUT_WINDOW_MS,
  WORKING_WINDOWS,
  outputRun,
  outputSaysWorking,
  stampingInput,
  type OutputRun,
} from "./output-activity"

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
