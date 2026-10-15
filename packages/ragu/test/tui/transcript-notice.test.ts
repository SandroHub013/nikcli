import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { transcriptFailedLines } from "@tui/util/transcript-notice"

/*
 * Review of the UI, N10: a transcript that cannot be drawn left one grey line, «details are in the log», with no
 * path to the log and no way out.
 */
describe("the notice for a transcript that cannot be drawn", () => {
  test("says what happened, where the log is, and the ways out", () => {
    const lines = transcriptFailedLines({
      message: "This conversation can't be shown here.",
      logFile: "C:/Users/me/.local/share/ragu/log/2026-10-16.log",
      exits: "Other ways out: ctrl+x l opens another session · /export saves this one",
    })
    expect(lines).toEqual([
      "This conversation can't be shown here.",
      "Log: C:/Users/me/.local/share/ragu/log/2026-10-16.log",
      "Other ways out: ctrl+x l opens another session · /export saves this one",
    ])
  })

  test("what is not known is left out, not printed empty", () => {
    expect(transcriptFailedLines({ message: "m" })).toEqual(["m"])
  })

  test("the session view gives it the log, both exits (the key as the user bound it) and the error colour", () => {
    const source = readFileSync(join(import.meta.dir, "../../../tui/src/routes/session/index.tsx"), "utf8")
    const block = source.slice(source.indexOf("<TranscriptBoundary"), source.indexOf("<TranscriptBoundary") + 600)
    expect(block).toContain("logFile={Log.file()}")
    expect(block).toContain('keybind.print("session_list")')
    expect(block).toContain("/export")
    expect(block).toContain("theme.status.error.fg")
    expect(block).not.toContain("theme.status.warning.fg")
  })
})
