import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { panelEscape, panelFrame, panelListensEarly, panelTrapsTab } from "./panel-keys"
import { voiceSettingsSource } from "../test-support/voice-settings-source"

/*
 * kobalte-overlay, the Settings sheet: ADE now draws the dialog around the
 * panel. Framed, the panel must leave Escape and Tab to the host's dialog,
 * except the Escapes that are its own, which it must claim first.
 */
describe("Escape in the settings panel", () => {
  test("framed, a plain Escape is the host's: the panel does not close itself", () => {
    expect(panelEscape({ frame: "framed", recording: false, resetArmed: false, closable: true })).toBe("host")
  })

  test("framed or not, an Escape while recording a shortcut only stops the recording", () => {
    for (const frame of ["framed", "standalone", "inline"] as const) {
      expect(panelEscape({ frame, recording: true, resetArmed: true, closable: true })).toBe("stop-recording")
    }
  })

  test("an armed «Ripristina» is disarmed, not the panel closed", () => {
    expect(panelEscape({ frame: "framed", recording: false, resetArmed: true, closable: true })).toBe("disarm")
  })

  test("standalone, as before: Escape closes it, where it can close", () => {
    expect(panelEscape({ frame: "standalone", recording: false, resetArmed: false, closable: true })).toBe("close")
    expect(panelEscape({ frame: "standalone", recording: false, resetArmed: false, closable: false })).toBe("host")
  })
})

describe("Tab and where the panel listens", () => {
  test("only a standalone panel traps Tab; framed, the host's trap does", () => {
    expect(panelTrapsTab("standalone")).toBe(true)
    expect(panelTrapsTab("framed")).toBe(false)
    expect(panelTrapsTab("inline")).toBe(false)
  })

  test("framed, it listens before the host's dialog does", () => {
    expect(panelListensEarly("framed")).toBe(true)
    expect(panelListensEarly("standalone")).toBe(false)
  })

  test("inline wins over framed; framed only when asked", () => {
    expect(panelFrame({ inline: true, framed: true })).toBe("inline")
    expect(panelFrame({ framed: true })).toBe("framed")
    expect(panelFrame({})).toBe("standalone")
  })
})

describe("lint: the panel uses these rules", () => {
  const panel = voiceSettingsSource()

  test("lint: its keyboard handler asks panelEscape and panelTrapsTab", () => {
    expect(panel.includes("panelEscape({")).toBe(true)
    expect(panel.includes("panelTrapsTab(frame())")).toBe(true)
    expect(panel.includes("panelListensEarly(frame())")).toBe(true)
  })

  test("lint: framed, it draws no overlay and is not a dialog of its own", () => {
    const start = panel.indexOf('role={frame() === "standalone" ? "dialog"')
    expect(start).toBeGreaterThan(-1)
    expect(panel.includes('when={frame() === "standalone"}')).toBe(true)
  })
})
