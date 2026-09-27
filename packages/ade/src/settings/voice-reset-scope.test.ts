import { afterEach, expect, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { compileSolidJsx } from "../test-support/solid-jsx"
import { t } from "../i18n"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import postcss from "postcss"

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

function mount(initialSection: string, framed = false) {
  const host = document.createElement("div")
  document.body.append(host)
  dispose = render(
    () =>
      createComponent(VoiceSettingsPanel, {
        engine,
        settings: { ...DEFAULT_VOICE_SETTINGS },
        onChange: () => {},
        // As ADE mounts it (workbench.tsx): framed by its Sheet, with a close.
        ...(framed ? { framed: true, onClose: () => {} } : { inline: true }),
        initialSection,
        builtInGroup: "Voce",
        extraGroup: "ADE",
        extraSections: [
          { id: "set-sec-theme", label: "Tema", glyph: "◐", render: () => document.createElement("div") },
        ],
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

test("the header keeps the close on its one row, whatever it holds", () => {
  // The header is a grid of four tracks. With the reset beside the status pill
  // it holds five things, and the fifth — the X — wrapped under the title, on
  // the left (Verifiche: y 166 against 113). Every child has to have a track in
  // the same row: either as many columns as children, or columns made on demand.
  const host = mount("voice-sec-mode", true)
  const header = host.querySelector('[data-slot="header"]')!
  const children = header.children.length
  expect(children).toBe(5)
  const sheet = readFileSync(
    join(import.meta.dir, "..", "..", "..", "voice", "src", "ui", "voice-settings.css"),
    "utf-8",
  )
  let body = ""
  let narrowClose = ""
  postcss.parse(sheet).walkRules((rule) => {
    const narrow = rule.parent?.type === "atrule"
    if (rule.selector === '[data-component="voice-settings-panel"] [data-slot="header"]' && !narrow)
      body = rule.toString()
    if (rule.selector === '[data-component="voice-settings-panel"] [data-slot="close-btn"]' && narrow)
      narrowClose = rule.toString()
  })
  // Narrow, the header wraps on purpose (the pill takes a row): the X is pinned
  // to the first row there.
  expect(narrowClose).toContain("grid-row: 1")
  const tracks = (/grid-template-columns:\s*([^;]+);/.exec(body)?.[1] ?? "")
    .trim()
    .split(/\s+(?![^(]*\))/)
    .filter(Boolean).length
  const onDemand = /grid-auto-flow:\s*column/.test(body)
  expect([children, tracks, onDemand, onDemand || tracks >= children]).toEqual([children, tracks, onDemand, true])
})
