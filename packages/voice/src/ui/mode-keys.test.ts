import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createVoiceSettingsState } from "./settings-state"
import { DEFAULT_VOICE_SETTINGS } from "../settings/model"

const modeSource = readFileSync(join(import.meta.dir, "settings-pages", "mode.tsx"), "utf8")

describe("UX2-8: keyboard support for alertsListen switch", () => {
  test("alertsListen radiogroup has onKeyDown wired to alertsListenKeys", () => {
    expect(modeSource).toContain('aria-labelledby="agent-alerts-listen-label"')
    expect(modeSource).toContain("onKeyDown={alertsListenKeys}")
  })

  test("settings state exposes alertsListenKeys that updates alertsListen on radio selection", () => {
    const updates: any[] = []
    const mockEngine = {
      isRunning: () => false,
      status: () => "idle",
      micLevel: () => 0,
      partialTranscript: () => "",
      lastSpoken: () => "",
      listenSpend: () => ({ current: 0, limit: 0 }),
    }
    const state = createVoiceSettingsState({
      engine: mockEngine as any,
      settings: { ...DEFAULT_VOICE_SETTINGS, spokenAlerts: true, alertsListen: false },
      onChange: (next) => updates.push(next),
    })

    expect((state as any).alertsListenKeys).toBeDefined()
    const group = document.createElement("div")
    group.setAttribute("role", "radiogroup")
    const radioOn = document.createElement("div")
    radioOn.setAttribute("role", "radio")
    radioOn.setAttribute("data-value", "on")
    group.appendChild(radioOn)

    const event = {
      key: " ",
      currentTarget: group,
      target: radioOn,
      preventDefault: () => {},
    } as unknown as KeyboardEvent

    ;(state as any).alertsListenKeys(event)
    expect(updates.some((u) => u.alertsListen === true)).toBe(true)
  })
})
