import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { DEFAULT_VOICE_SETTINGS } from "@nikcli-ai/voice/core"
import { DEFAULT_BINDINGS, resolveDefaultBindings } from "../keyboard/bindings"
import { parseChord, type Platform } from "../keyboard/keymap"
import { resolveVoiceOrAdeKey } from "../voice/shortcuts"
import { FORWARDABLE, forwardedCommand, type ForwardedChord } from "./navigation"

const platforms: Platform[] = ["mac", "other"]

/** A chord string as the plugin would forward it: the keys, with the platform's `mod`. */
const forwarded = (text: string, platform: Platform): ForwardedChord => {
  const chord = parseChord(text, platform)
  return { key: chord.key, ctrl: chord.ctrl, alt: chord.alt, shift: chord.shift, meta: chord.meta }
}

describe("a chord from the plugin runs only navigation", () => {
  test("the palette, the section and the bar are forwarded, on both platforms, as the command ids", () => {
    for (const platform of platforms) {
      const bindings = resolveDefaultBindings(platform)
      expect(forwardedCommand(bindings, forwarded("mod+shift+p", platform), platform)).toBe("palette.open")
      expect(forwardedCommand(bindings, forwarded("mod+shift+v", platform), platform)).toBe("view.toggle")
      expect(forwardedCommand(bindings, forwarded("mod+shift+b", platform), platform)).toBe("sidebar.toggle")
    }
  })

  test("closing a pane, a new session, a rename and the theme are ADE's bindings and are not forwarded", () => {
    for (const platform of platforms) {
      const bindings = resolveDefaultBindings(platform)
      for (const chord of ["mod+w", "mod+n", "f2", "mod+shift+t", "mod+shift+m"]) {
        expect([platform, chord, forwardedCommand(bindings, forwarded(chord, platform), platform)]).toEqual([
          platform,
          chord,
          undefined,
        ])
      }
    }
  })

  test("of every binding ADE has, only the ones on the list get through", () => {
    for (const platform of platforms) {
      const bindings = resolveDefaultBindings(platform)
      let through = 0
      for (const entry of DEFAULT_BINDINGS) {
        const got = forwardedCommand(bindings, forwarded(entry.chord, platform), platform)
        expect([entry.chord, got]).toEqual([entry.chord, FORWARDABLE.has(entry.commandId) ? entry.commandId : undefined])
        if (got) through++
      }
      expect(through).toBe(FORWARDABLE.size)
    }
  })

  test("every command on the list is a real binding, so the list cannot name a command that does not exist", () => {
    const bound = new Set(DEFAULT_BINDINGS.map((entry) => entry.commandId))
    for (const id of FORWARDABLE) expect([id, bound.has(id)]).toEqual([id, true])
  })

  test("nothing that creates, closes, records, speaks or leaves is on the list", () => {
    const never = [
      "pane.close",
      "panes.closeGone",
      "session.new",
      "session.suspend",
      "process.kill",
      "voice.toggle",
      "voice.settings",
      "record.toggle",
      "record.export",
      "project.open",
      "update.check",
      "app.quit",
      "window.close",
    ]
    for (const id of never) expect([id, FORWARDABLE.has(id)]).toEqual([id, false])
  })

  test("the voice chords, which are not ADE's bindings, resolve to nothing however they are forwarded", () => {
    for (const platform of platforms) {
      const bindings = resolveDefaultBindings(platform)
      for (const mode of ["agentChord", "transcriptionChord"] as const) {
        const text = DEFAULT_VOICE_SETTINGS[mode]
        const chord = forwarded(text, platform)
        // The chord is real: pressed on ADE's own window, the voice handler is what answers it.
        const pressed = { key: chord.key, ctrlKey: chord.ctrl, metaKey: chord.meta, shiftKey: chord.shift, altKey: chord.alt }
        expect([mode, resolveVoiceOrAdeKey(bindings, DEFAULT_VOICE_SETTINGS, pressed, platform).type]).not.toEqual([mode, "none"])
        // Forwarded by the plugin it runs nothing.
        expect([platform, mode, forwardedCommand(bindings, chord, platform)]).toEqual([platform, mode, undefined])
      }
    }
  })

  test("a chord nothing is bound to, or with the wrong modifiers, runs nothing", () => {
    const bindings = resolveDefaultBindings("other")
    const chord = forwarded("mod+shift+p", "other")
    expect(forwardedCommand(bindings, { ...chord, ctrl: false }, "other")).toBeUndefined()
    expect(forwardedCommand(bindings, { ...chord, alt: true }, "other")).toBeUndefined()
    expect(forwardedCommand(bindings, { ...chord, key: "q" }, "other")).toBeUndefined()
    expect(forwardedCommand([], chord, "other")).toBeUndefined()
  })

  test("lint: the panel runs the command and dispatches no keyboard event, and the plugin's wire has no keys of its own to send", () => {
    for (const name of ["plugin-pane.tsx", "api.ts", "link.ts"]) {
      expect([name, /dispatchEvent|new KeyboardEvent|chordEvent/.test(readFileSync(join(import.meta.dir, name), "utf8"))]).toEqual([name, false])
    }
    const workbench = readFileSync(join(import.meta.dir, "..", "surface", "workbench.tsx"), "utf8")
    const start = workbench.indexOf("forwardedNavigation(bindings")
    expect(start).toBeGreaterThan(0)
    // The id ADE resolved goes to `runCommand`, and only when there is one; no other command is run for a chord.
    expect(workbench.slice(start, start + 300)).toContain("if (id) {")
    expect(workbench.slice(start, start + 300).match(/runCommand\(/g)).toHaveLength(1)
  })
})
