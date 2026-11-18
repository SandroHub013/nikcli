import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { workbenchSource } from "../test-support/workbench-source"

const source = workbenchSource()

describe("workbench, low findings of the full review 2026-10-06", () => {
  // sessions 19: the settings switch compared Piper's voice with the MAI one, which are never equal, and reset the state of
  // the local voice at every change.
  test("the settings change compares the local voice with the local voice", () => {
    expect(source).toContain("const previousVoice = activePiperVoice()")
    expect(source).toContain("const nextVoice = activeReplyVoice(localReplyVoice(saved.settings), locale())")
    expect(source).not.toContain("activeReplyVoice(saved.settings.replyVoice, locale())")
  })

  // sessions 15: a captured frame is out of git's sight like the rest of `.ade/`.
  test("a captured frame makes sure `.ade/` is excluded from git", () => {
    const at = source.indexOf("const captureFrame = async")
    const body = source.slice(at, source.indexOf("\n  }\n", at))
    expect(body).toContain("excludeAdeResults(host, root)")
  })
})

describe("OpenCode 2.x stored model and early close reason (review 2026-11-18)", () => {
  test("startProcess drops stored --model for OpenCode 2.x before startArgsFor", () => {
    expect(source).toContain("shouldDropOpencodeModel")
    expect(source).toContain("withoutModel(launched?.spawnArgs ?? [])")
    expect(source).toContain("tellPane(paneId, OPENCODE_MODEL_DROPPED_NOTE)")
  })

  test("workbench settles early closed session with earlyCloseReason", () => {
    expect(source).toContain("earlyCloseReason(closed?.activity, closed?.lines)")
  })
})
