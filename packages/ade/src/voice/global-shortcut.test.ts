import { describe, expect, test } from "bun:test"
import {
  modeForGlobalChord,
  parseGlobalChord,
  readGlobalVoicePayload,
  toTauriChord,
} from "./global-shortcut"

describe("toTauriChord", () => {
  test("mod resolves per platform on the native side", () => {
    expect(toTauriChord("mod+shift+k")).toBe("CommandOrControl+Shift+K")
  })

  test("an explicit ctrl or cmd is not folded into CommandOrControl", () => {
    expect(toTauriChord("ctrl+k")).toBe("Control+K")
    expect(toTauriChord("cmd+k")).toBe("Super+K")
  })

  test("named keys keep a spelling the crate parses", () => {
    expect(toTauriChord("mod+space")).toBe("CommandOrControl+SPACE")
    expect(toTauriChord("alt+arrowup")).toBe("Alt+ARROWUP")
    expect(toTauriChord("mod+alt+f9")).toBe("CommandOrControl+Alt+F9")
  })
})

describe("parseGlobalChord", () => {
  test("reads the crate's own print format", () => {
    expect(parseGlobalChord("shift+control+KeyK")).toEqual({
      key: "k",
      ctrl: true,
      meta: false,
      shift: true,
      alt: false,
    })
    expect(parseGlobalChord("control+Space")).toEqual({
      key: "space",
      ctrl: true,
      meta: false,
      shift: false,
      alt: false,
    })
    expect(parseGlobalChord("super+Digit1").meta).toBe(true)
  })
})

describe("modeForGlobalChord", () => {
  const settings = { agentChord: "mod+space", transcriptionChord: "mod+shift+j" }

  /*
   * The case that was broken: a chord with no "j" or "k" in it. The old
   * listener matched on those two letters and dropped everything else.
   */
  test("Ctrl+Space opens the agent when that is the configured chord", () => {
    expect(modeForGlobalChord("control+Space", settings, "other")).toBe("agent")
  })

  test("the transcription chord is told apart from the agent one", () => {
    expect(modeForGlobalChord("shift+control+KeyJ", settings, "other")).toBe("transcription")
  })

  test("mod is Command on a Mac and Control elsewhere", () => {
    expect(modeForGlobalChord("super+Space", settings, "mac")).toBe("agent")
    expect(modeForGlobalChord("control+Space", settings, "mac")).toBeUndefined()
    expect(modeForGlobalChord("super+Space", settings, "other")).toBeUndefined()
  })

  test("a chord that merely contains a letter of the default is not a match", () => {
    // "backspace" contains a "k": the old listener toggled the agent on it.
    expect(modeForGlobalChord("control+Backspace", settings, "other")).toBeUndefined()
    expect(modeForGlobalChord("", settings, "other")).toBeUndefined()
  })
})

describe("readGlobalVoicePayload", () => {
  test("understands the structured payload", () => {
    expect(readGlobalVoicePayload({ chord: "control+Space", state: "released" })).toEqual({
      chord: "control+Space",
      state: "released",
    })
  })

  test("still understands the bare string an older native build sends", () => {
    expect(readGlobalVoicePayload("control+Space")).toEqual({ chord: "control+Space", state: "pressed" })
  })

  test("rejects what is neither", () => {
    expect(readGlobalVoicePayload("")).toBeUndefined()
    expect(readGlobalVoicePayload({ state: "pressed" })).toBeUndefined()
    expect(readGlobalVoicePayload(42)).toBeUndefined()
  })
})
