import { afterEach, expect, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { compileSolidJsx } from "../test-support/solid-jsx"
import { t } from "../i18n"

/*
 * «Ripristina la voce» resets the voice settings and nothing else. In ADE the
 * voice panel is the whole settings sheet, with ADE's own sections added after
 * the voice ones, and the button sat in the header on every one of them: on
 * Tema or Lingua it offered to reset something that page does not show.
 *
 * Mounted for real, as ADE mounts it, rather than read as text: the fault is
 * what is on screen for a given section.
 */

if (typeof document === "undefined") GlobalRegistrator.register()
compileSolidJsx()

const { createComponent, render } = await import("solid-js/web")
const { VoiceSettingsPanel } = await import("@nikcli-ai/voice")
const { DEFAULT_VOICE_SETTINGS } = await import("@nikcli-ai/voice/core")

const engine = {
  isRunning: () => false,
  status: () => "idle",
  micLevel: () => 0,
  partialTranscript: () => "",
  lastSpoken: () => "",
  lastError: () => undefined,
  listenSpend: () => ({ calls: 0, cost: 0 }),
  toggle: () => {},
  cancel: () => {},
} as never

let dispose: (() => void) | undefined
afterEach(() => {
  dispose?.()
  dispose = undefined
  document.body.innerHTML = ""
})

function mount(initialSection: string) {
  const host = document.createElement("div")
  document.body.append(host)
  dispose = render(
    () =>
      createComponent(VoiceSettingsPanel, {
        engine,
        settings: { ...DEFAULT_VOICE_SETTINGS },
        onChange: () => {},
        inline: true,
        initialSection,
        builtInGroup: "Voce",
        extraGroup: "ADE",
        extraSections: [{ id: "set-sec-theme", label: "Tema", glyph: "◐", render: () => document.createElement("div") }],
      }),
    host,
  )
  return host
}

// The first mount compiles the panel's whole tree (and waits on the first read
// of each file); done once here, outside any test's 5 s budget.
mount("voice-sec-mode")
dispose?.()
dispose = undefined
document.body.innerHTML = ""

const resetButton = (host: HTMLElement) =>
  [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === t("vui.panel.resetVoice"))

test("on one of ADE's own sections the header offers no voice reset", () => {
  expect(Boolean(resetButton(mount("set-sec-theme")))).toBe(false)
})

test("on every voice section the header still offers it", () => {
  for (const id of ["voice-sec-mode", "voice-sec-devices", "voice-sec-backend", "voice-sec-commands"]) {
    const host = mount(id)
    expect([id, Boolean(resetButton(host))]).toEqual([id, true])
    dispose?.()
    dispose = undefined
    host.remove()
  }
})
