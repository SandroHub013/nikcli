import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { localePreference, setLocalePreference } from "@nikcli-ai/ade/i18n"
import { DEFAULT_VOICE_SETTINGS } from "../settings/model"
import { orbTitle } from "./orb-title"

describe("ui/orb-title", () => {
  test("«Microfono · <chord>», with the chord of the mode the orb opens", () => {
    const before = localePreference()
    setLocalePreference("it")
    const agent = { ...DEFAULT_VOICE_SETTINGS, mode: "agent" as const, agentChord: "mod+shift+k", transcriptionChord: "mod+shift+j" }
    expect(orbTitle(agent, "other")).toBe("Microfono · Ctrl+Shift+K")
    expect(orbTitle({ ...agent, mode: "transcription" }, "other")).toBe("Microfono · Ctrl+Shift+J")
    setLocalePreference("en")
    expect(orbTitle(agent, "other")).toBe("Microphone · Ctrl+Shift+K")
    setLocalePreference(before)
  })

  test("the orb's tooltip is that one; its accessible name keeps saying what the microphone is doing", () => {
    const orb = readFileSync(join(import.meta.dir, "voice-orb.tsx"), "utf8")
    expect(orb).toContain("aria-label={label()}")
    expect(orb).toContain("title={orbTitle(props.engine.settings(), getPlatform())}")
    expect(orb).not.toContain("title={label()}")
  })
})
