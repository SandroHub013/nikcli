import { describe, expect, test } from "bun:test"
import { workbenchSource } from "../test-support/workbench-source"
import { codeOf } from "../test-support/source-text"
import { translate } from "../i18n"
import { DEFAULT_VOICE_SETTINGS } from "@ragu/voice/core"
import {
  globalVoiceAction,
  modeForGlobalChord,
  registerVoiceShortcuts,
  serialiseRegistrations,
  shortcutsNote,
  unknownChordMessage,
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

describe("registerVoiceShortcuts", () => {
  const settings = { agentChord: "mod+shift+k", transcriptionChord: "mod+space" }

  test("with default settings, the register dependency of registerVoiceShortcuts is never called", async () => {
    let called = false
    await registerVoiceShortcuts(DEFAULT_VOICE_SETTINGS, {
      unregisterAll: async () => {},
      register: async () => {
        called = true
      },
    })
    expect(called).toBe(false)
  })

  test("a chord another application holds does not take the other one down with it", async () => {
    const registered: string[] = []
    const said: string[] = []
    const result = await registerVoiceShortcuts(settings, {
      unregisterAll: async () => {},
      // Ctrl+Space is often already claimed: the dictation chord fails, the assistant's must not.
      register: async (chord) => {
        if (chord === "CommandOrControl+SPACE") throw new Error("HotKey already registered")
        registered.push(chord)
      },
      report: (message) => said.push(message),
    })

    expect(registered).toEqual(["CommandOrControl+Shift+K"])
    expect(result.registered).toEqual(["agent"])
    expect(result.failed).toHaveLength(1)
    expect(result.failed[0]).toMatchObject({ mode: "transcription", chord: "mod+space" })
    // Said in the interface, not only in the console.
    expect(said).toHaveLength(1)
    expect(said[0]).toContain("mod+space")
    expect(said[0]).toContain("dettatura")
  })

  test("both chords are claimed, the previous ones dropped first", async () => {
    const order: string[] = []
    const result = await registerVoiceShortcuts(settings, {
      unregisterAll: async () => void order.push("unregister"),
      register: async (chord) => void order.push(chord),
    })

    expect(order).toEqual(["unregister", "CommandOrControl+SPACE", "CommandOrControl+Shift+K"])
    expect(result.failed).toHaveLength(0)
  })

  test("the two chords of this user's settings are told apart on both sides", () => {
    // What the OS reports for each, as `global-hotkey` prints it.
    expect(modeForGlobalChord("shift+control+KeyK", settings, "other")).toBe("agent")
    expect(modeForGlobalChord("control+Space", settings, "other")).toBe("transcription")
  })
})

describe("globalVoiceAction", () => {
  const settings = { agentChord: "mod+shift+k", transcriptionChord: "mod+space" }

  test("each chord opens its own feature, on press", () => {
    expect(globalVoiceAction({ chord: "shift+control+KeyK", state: "pressed" }, settings, "other")).toEqual({
      kind: "press",
      mode: "agent",
    })
    expect(globalVoiceAction({ chord: "control+Space", state: "pressed" }, settings, "other")).toEqual({
      kind: "press",
      mode: "transcription",
    })
    expect(globalVoiceAction({ chord: "control+Space", state: "released" }, settings, "other")).toEqual({
      kind: "release",
    })
  })

  test("a chord ADE cannot place is said, never turned into dictation", () => {
    const action = globalVoiceAction({ chord: "control+F24", state: "pressed" }, settings, "other")
    expect(action).toEqual({ kind: "unknown", chord: "control+F24" })
    expect(unknownChordMessage("control+F24")).toContain("non riconosciuta")
    // The dangerous answer would be a mode: with the stored mode on dictation,
    // the assistant's chord would open the microphone for dictation instead.
    expect(action).not.toHaveProperty("mode")
  })

  test("a chord on a punctuation key is recognised: the recorder writes «,», the system says «Comma»", () => {
    const punctuation = { agentChord: "mod+,", transcriptionChord: "mod+." }
    expect(globalVoiceAction({ chord: "control+Comma", state: "pressed" }, punctuation, "other")).toEqual({
      kind: "press",
      mode: "agent",
    })
    expect(globalVoiceAction({ chord: "control+Period", state: "pressed" }, punctuation, "other")).toEqual({
      kind: "press",
      mode: "transcription",
    })
  })

  test("an empty or malformed payload does nothing at all", () => {
    expect(globalVoiceAction(undefined, settings, "other")).toEqual({ kind: "ignore" })
    expect(globalVoiceAction({ state: "pressed" }, settings, "other")).toEqual({ kind: "ignore" })
  })
})

describe("serialiseRegistrations", () => {
  /** A registration the test releases by hand, so two calls can overlap. */
  function gate() {
    const opened: string[] = []
    const gates = new Map<string, () => void>()
    const released = new Set<string>()
    const register = async (chord: string) => {
      opened.push(chord)
      // A release that arrived before the registration is remembered.
      if (released.has(chord)) return
      await new Promise<void>((resolve) => gates.set(chord, resolve))
    }
    return { register, opened, release: (chord: string) => void (released.add(chord), gates.get(chord)?.()) }
  }

  test("two saves in a row do not overlap: the second waits for the first", async () => {
    const g = gate()
    const save = serialiseRegistrations(g.register)

    const first = save("ctrl+space")
    // The second save arrives while the first is still at the OS.
    const second = save("ctrl+k")
    expect(g.opened).toEqual(["ctrl+space"])

    g.release("ctrl+space")
    g.release("ctrl+k")
    await Promise.all([first, second])
    expect(g.opened).toEqual(["ctrl+space", "ctrl+k"])
  })

  test("a save still waiting when a newer one arrives never reaches the OS", async () => {
    const g = gate()
    const save = serialiseRegistrations(g.register)

    const first = save("ctrl+space")
    const superseded = save("ctrl+j")
    const newest = save("ctrl+k")
    // The middle chord is not worth claiming, and claiming it would report a
    // chord the user had already changed away from as busy.
    g.release("ctrl+space")
    g.release("ctrl+k")
    await Promise.all([first, superseded, newest])
    expect(g.opened).toEqual(["ctrl+space", "ctrl+k"])
  })

  test("a registration that fails does not leave the next one stuck", async () => {
    const opened: string[] = []
    const save = serialiseRegistrations(async (chord: string) => {
      opened.push(chord)
      if (chord === "ctrl+broken") throw new Error("il sistema ha rifiutato")
    })

    await save("ctrl+broken")
    await save("ctrl+k")
    expect(opened).toEqual(["ctrl+broken", "ctrl+k"])
  })

  test("saves made one after another all run, in order", async () => {
    const opened: string[] = []
    const save = serialiseRegistrations(async (chord: string) => {
      opened.push(chord)
    })
    await save("ctrl+a")
    await save("ctrl+b")
    await save("ctrl+c")
    expect(opened).toEqual(["ctrl+a", "ctrl+b", "ctrl+c"])
  })
})

/*
 * The default engine is grok-stream and runs on an xAI key that lives in the keychain, not in the settings: a user who
 * set voice up with only that key, and kept the default chords, must keep both shortcuts.
 */
describe("the xAI key counts as voice set up", () => {
  const defaults = { agentChord: "mod+shift+k", transcriptionChord: "mod+shift+j" }
  const claim = async (settings: Parameters<typeof registerVoiceShortcuts>[0]) => {
    const calls: string[] = []
    const result = await registerVoiceShortcuts(settings, {
      unregisterAll: async () => void calls.push("unregister"),
      register: async (chord) => void calls.push(chord),
    })
    return { calls, claimed: calls.filter((call) => call !== "unregister"), result }
  }

  test("only the xAI key, default chords: both chords are claimed", async () => {
    const { claimed, result } = await claim({ ...defaults, hasXaiKey: true })
    expect(claimed.sort()).toEqual(["CommandOrControl+Shift+J", "CommandOrControl+Shift+K"])
    expect(result.notSetUp).toBeUndefined()
  })

  /* A guard against the opposite fault: the claimed list is empty with or without the xAI fix. The held keys are dropped first. */
  test("no key, default chords: what was held is dropped, nothing is claimed, and it is flagged", async () => {
    const { calls, result } = await claim({ ...defaults, hasXaiKey: false })
    expect(calls).toEqual(["unregister"])
    expect(result.notSetUp).toBe(true)
  })

  test("chords of the user's own: claimed without any key", async () => {
    const { claimed, result } = await claim({ agentChord: "mod+space", transcriptionChord: "mod+shift+j", hasXaiKey: false })
    expect(claimed).toHaveLength(2)
    expect(result.notSetUp).toBeUndefined()
  })
})

describe("the note the shortcuts block shows", () => {
  const note = shortcutsNote

  test("claimed: no note", () => {
    expect(note({ notClaimed: false, xaiKeyMasked: null, unreadable: false })).toBeUndefined()
  })

  test("no key, read: says how to turn them on", () => {
    expect(note({ notClaimed: true, xaiKeyMasked: null, unreadable: false })).toBe(translate("it", "voice.shortcut.notSetUp"))
  })

  test("read failed and nothing known: says the key could not be read, never to save one", () => {
    const text = note({ notClaimed: true, xaiKeyMasked: undefined, unreadable: true })
    expect(text).toBe(translate("it", "voice.shortcut.keyUnreadable"))
    expect(text).not.toBe(translate("it", "voice.shortcut.notSetUp"))
  })

  test("still waiting for the first read: no note at all", () => {
    expect(note({ notClaimed: true, xaiKeyMasked: undefined, unreadable: false })).toBeUndefined()
  })

  test("a later failed read keeps what the last good read said", () => {
    expect(note({ notClaimed: true, xaiKeyMasked: null, unreadable: true })).toBe(translate("it", "voice.shortcut.notSetUp"))
  })

  for (const language of ["it", "en"] as const) {
    test(`the text in ${language} keeps its points: only system-wide, where the keys are saved, which key, other keys turn it on`, () => {
      const text = translate(language, "voice.shortcut.notSetUp")
      expect(text).toContain("xAI")
      expect(text).toContain("OpenRouter")
      expect(text).toContain(language === "it" ? "Agenti e account › Chiavi API" : "Agents and accounts › API keys")
      expect(text).toContain(language === "it" ? "ADE in primo piano" : "ADE is in front")
      expect(text).toContain(language === "it" ? "tasti diversi" : "different keys")
      expect(text.toLowerCase()).not.toContain("chord")
      expect(translate(language, "voice.shortcut.keyUnreadable").toLowerCase()).not.toContain("chord")
    })
  }
})

describe("lint: the workbench hands the gate the keychain's answer", () => {
  const workbench = codeOf(workbenchSource())

  test("the gate gets the xAI key's presence, the settings get one note", () => {
    expect(workbench).toContain(codeOf("hasXaiKey: typeof xaiKeyMasked() === \"string\""))
    expect(workbench).toContain(codeOf("setShortcutsNotClaimed(notSetUp === true)"))
    expect(workbench).toContain(codeOf("shortcutsNote={shortcutsNote({"))
  })

  test("the read goes through the watch, which claims again, and runs again as the voice settings open", () => {
    expect(workbench).toContain(codeOf("claim: () => void registerGlobalShortcuts?.(voiceSettings())"))
    expect(workbench).toContain(codeOf("await xaiKeyWatch.refresh()"))
    expect(workbenchSource()).toMatch(
      /if \(!voiceSettingsOpen\(\) \|\| !keysAvailable\(\)\) return\s*(\/\/[^\n]*\n\s*)*void refreshXaiKey\(\)\s*const stop = watchKeychain/,
    )
  })
})

describe("workbench global shortcut initialization order", () => {
  test("registerGlobalShortcuts callback is assigned before initial syncGlobalShortcuts await", () => {
    const workbench = workbenchSource()
    const assignIndex = workbench.indexOf("registerGlobalShortcuts = syncGlobalShortcuts")
    const syncIndex = workbench.indexOf("await syncGlobalShortcuts(voiceSettings())")
    expect(assignIndex).toBeGreaterThan(-1)
    expect(syncIndex).toBeGreaterThan(-1)
    expect(assignIndex).toBeLessThan(syncIndex)
  })
})
