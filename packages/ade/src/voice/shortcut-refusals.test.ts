import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { codeOf } from "../test-support/source-text"
import { refusalsOf, registerVoiceShortcuts } from "./global-shortcut"

/*
 * A chord another application already holds cannot be registered, and the only
 * word of it was a notice at startup. Coming back later to find out why the
 * chord does nothing, the voice settings showed it exactly like one that works.
 */
describe("a chord the system refuses", () => {
  const settings = { agentChord: "mod+shift+k", transcriptionChord: "mod+shift+j" }

  test("is named beside that chord, and only that one", async () => {
    const result = await registerVoiceShortcuts(settings, {
      unregisterAll: async () => {},
      register: async (chord) => {
        if (chord.endsWith("+J")) throw new Error("HotKey already registered")
      },
    })
    const refusals = refusalsOf(result.failed)
    expect(Object.keys(refusals)).toEqual(["transcription"])
    expect(refusals.transcription).toContain("mod+shift+j")
    expect(refusals.transcription).toContain("dettatura")
  })

  test("a registration that claims both leaves nothing to show", async () => {
    const result = await registerVoiceShortcuts(settings, { unregisterAll: async () => {}, register: async () => {} })
    expect(refusalsOf(result.failed)).toEqual({})
  })
})

describe("lint: the refusal reaches the voice settings", () => {
  const workbench = codeOf(readFileSync(new URL("../surface/workbench.tsx", import.meta.url), "utf8"))
  const panel = codeOf(readFileSync(new URL("../../../voice/src/ui/voice-settings-panel.tsx", import.meta.url), "utf8"))

  test("the workbench keeps what the last registration refused, and hands it to the panel", () => {
    expect(workbench).toContain(codeOf("setShortcutRefusals(refusalsOf(failed))"))
    expect(workbench).toContain(codeOf("shortcutRefusals={shortcutRefusals()}"))
  })

  test("the panel shows it where it shows the chord's other problems", () => {
    expect(panel).toContain(codeOf("props.shortcutRefusals?.[field]"))
  })
})
