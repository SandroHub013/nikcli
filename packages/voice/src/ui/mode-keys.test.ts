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
    class FakeElement {
      constructor(
        public readonly role: string,
        public readonly attributes: Record<string, string> = {},
        public readonly parent?: FakeElement,
      ) {}
      getAttribute(name: string) {
        return this.attributes[name] ?? (name === "role" ? this.role : null)
      }
      closest(selector: string): FakeElement | null {
        if (selector === '[role="radio"]' && this.role === "radio") return this
        if (selector === '[role="radiogroup"]') {
          if (this.role === "radiogroup") return this
          return this.parent?.closest(selector) ?? null
        }
        return null
      }
    }

    const prevHtmlElement = (globalThis as any).HTMLElement
    ;(globalThis as any).HTMLElement = FakeElement

    try {
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
      const group = new FakeElement("radiogroup")
      const radioOn = new FakeElement("radio", { "data-value": "on" }, group)

      let prevented = false
      const event = {
        key: " ",
        currentTarget: group,
        target: radioOn,
        preventDefault: () => {
          prevented = true
        },
      } as unknown as KeyboardEvent

      ;(state as any).alertsListenKeys(event)
      expect(prevented).toBe(true)
      expect(updates.some((u) => u.alertsListen === true)).toBe(true)
    } finally {
      ;(globalThis as any).HTMLElement = prevHtmlElement
    }
  })
})
