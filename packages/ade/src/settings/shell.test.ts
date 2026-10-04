import { afterEach, beforeAll, describe, expect, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { compileSolidJsx } from "../test-support/solid-jsx"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import postcss from "postcss"
import { SETTINGS_VIEW_STORAGE_KEY } from "./categories"

if (typeof document === "undefined") GlobalRegistrator.register()
compileSolidJsx()

const { createComponent, render } = await import("solid-js/web")
const { SettingsShell } = await import("./shell")
const { VoiceSettingsPanel } = await import("@nikcli-ai/voice")
const { DEFAULT_VOICE_SETTINGS } = await import("@nikcli-ai/voice/core")

let dispose: (() => void) | undefined
afterEach(() => {
  dispose?.()
  dispose = undefined
  document.body.innerHTML = ""
  localStorage.clear()
})

const fakeVoiceEngine = {
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

function renderShell(options: {
  initialTarget?: string
  onClose?: () => void
  version?: string
} = {}) {
  const host = document.createElement("div")
  document.body.append(host)
  const onClose = options.onClose ?? (() => {})

  dispose = render(
    () =>
      createComponent(SettingsShell, {
        initialTarget: options.initialTarget,
        onClose,
        version: options.version ?? "0.9.1",
        renderContent: (category, tab) => {
          if (category === "voice") {
            return createComponent(VoiceSettingsPanel, {
              engine: fakeVoiceEngine,
              settings: { ...DEFAULT_VOICE_SETTINGS },
              onChange: () => {},
              inline: true,
              framed: true,
              onClose,
              title: "Voce",
            })
          }
          const div = document.createElement("div")
          div.dataset.slot = "dummy-section"
          div.innerHTML = `<h3 tabindex="-1">Section ${category}/${tab}</h3><button type="button">Focusable</button>`
          return div
        },
      }),
    host,
  )
  return host
}

describe("settings shell", () => {
  test("la rotella apre l'ultima vista salvata o Generale come fallback", () => {
    // 1. Without saved view -> fallback to General
    renderShell()
    let activeCat = document.body.querySelector('[data-slot="category-button"][data-active="true"]')
    expect(activeCat?.getAttribute("data-category")).toBe("general")
    dispose?.()
    document.body.innerHTML = ""

    // 2. With saved view in localStorage -> opens that view
    localStorage.setItem(
      SETTINGS_VIEW_STORAGE_KEY,
      JSON.stringify({ category: "agents", tab: "agents/keys" }),
    )
    renderShell()
    activeCat = document.body.querySelector('[data-slot="category-button"][data-active="true"]')
    expect(activeCat?.getAttribute("data-category")).toBe("agents")
    const activeTab = document.body.querySelector('[data-slot="settings-tab"][data-active="true"]')
    expect(activeTab?.getAttribute("data-tab")).toBe("agents/keys")
    dispose?.()
    document.body.innerHTML = ""
  })

  test("legacyTarget apre la scheda corrispondente", () => {
    // voice-sec-backend -> voice
    renderShell({ initialTarget: "voice-sec-backend" })
    let activeCat = document.body.querySelector('[data-slot="category-button"][data-active="true"]')
    expect(activeCat?.getAttribute("data-category")).toBe("voice")
    dispose?.()
    document.body.innerHTML = ""

    // set-sec-provider -> agents / agents/account
    renderShell({ initialTarget: "set-sec-provider" })
    activeCat = document.body.querySelector('[data-slot="category-button"][data-active="true"]')
    expect(activeCat?.getAttribute("data-category")).toBe("agents")
    const activeTab = document.body.querySelector('[data-slot="settings-tab"][data-active="true"]')
    expect(activeTab?.getAttribute("data-tab")).toBe("agents/account")
    dispose?.()
    document.body.innerHTML = ""
  })

  test("Esc chiude il pannello delle impostazioni", () => {
    let closed = false
    renderShell({ onClose: () => { closed = true } })
    const shellEl = document.body.querySelector<HTMLElement>('[data-component="settings-shell"]')
    expect(shellEl).toBeDefined()

    // Dispatch Escape key event on shell container
    shellEl!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    expect(closed).toBe(true)
  })

  test("le frecce muovono il fuoco nel menu e nelle schede", () => {
    renderShell()
    const categoryButtons = [...document.body.querySelectorAll<HTMLButtonElement>('[data-slot="category-button"]')]
    expect(categoryButtons.length).toBe(6)

    // Focus first category (General)
    categoryButtons[0]!.focus()

    // ArrowDown -> Agents
    categoryButtons[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }))
    expect(document.activeElement).toBe(categoryButtons[1]!)

    // ArrowUp -> General (wraps)
    categoryButtons[1]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }))
    expect(document.activeElement).toBe(categoryButtons[0]!)

    // End -> System (last)
    categoryButtons[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }))
    expect(document.activeElement).toBe(categoryButtons[5]!)

    // Home -> General (first)
    categoryButtons[5]!.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }))
    expect(document.activeElement).toBe(categoryButtons[0]!)

    // Tab buttons navigation
    const tabButtons = [...document.body.querySelectorAll<HTMLButtonElement>('[data-slot="settings-tab"]')]
    expect(tabButtons.length).toBeGreaterThan(1)

    tabButtons[0]!.focus()
    // ArrowRight -> next tab
    tabButtons[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }))
    expect(document.activeElement).toBe(tabButtons[1]!)

    // ArrowLeft -> previous tab
    tabButtons[1]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }))
    expect(document.activeElement).toBe(tabButtons[0]!)
  })

  test("in nessuna categoria tranne Voce ci sono status-pill, Avvia ascolto o Ripristina la voce", () => {
    // 1. In non-voice categories (e.g. General, Agents, Extensions, Record, System)
    for (const catId of ["general", "agents", "extensions", "record", "system"]) {
      renderShell({ initialTarget: catId })

      // Status pill should NOT exist
      const statusPill = document.body.querySelector('[data-slot="status-pill"]')
      expect(statusPill).toBeNull()

      // Listen button should NOT exist
      const listenBtn = [...document.body.querySelectorAll("button")].find(
        (b) => b.textContent?.includes("Avvia ascolto") || b.getAttribute("data-action") === "voice.listen",
      )
      expect(listenBtn).toBeUndefined()

      // Reset voice button should NOT exist
      const resetBtn = [...document.body.querySelectorAll("button")].find(
        (b) => b.textContent?.includes("Ripristina la voce"),
      )
      expect(resetBtn).toBeUndefined()

      // Done button exists
      const doneBtn = document.body.querySelector('[data-slot="settings-done"]')
      expect(doneBtn).toBeDefined()

      dispose?.()
      document.body.innerHTML = ""
    }

    // 2. In Voce category: status pill, listen button and reset voice button exist
    renderShell({ initialTarget: "voice" })
    const statusPill = document.body.querySelector('[data-slot="status-pill"]')
    expect(statusPill).not.toBeNull()

    const listenBtn = [...document.body.querySelectorAll("button")].find(
      (b) => b.textContent?.includes("Avvia ascolto") || b.getAttribute("data-action") === "voice.listen",
    )
    expect(listenBtn).toBeDefined()

    const resetBtn = [...document.body.querySelectorAll("button")].find(
      (b) => b.textContent?.includes("Ripristina la voce"),
    )
    expect(resetBtn).toBeDefined()
    dispose?.()
    document.body.innerHTML = ""
  })

  test("larghezza fino a ~1100 px e misure del layout in shell.css", () => {
    const cssPath = join(import.meta.dir, "shell.css")
    const cssText = readFileSync(cssPath, "utf-8")
    const parsed = postcss.parse(cssText)

    let maxWidth: string | undefined
    let width: string | undefined
    let railWidth: string | undefined
    let railNarrowWidth: string | undefined

    parsed.walkRules((rule) => {
      if (rule.selector === ".settings-shell" && rule.parent?.type !== "atrule") {
        rule.walkDecls((decl) => {
          if (decl.prop === "max-width") maxWidth = decl.value
          if (decl.prop === "width") width = decl.value
        })
      }
      if (rule.selector === '[data-slot="settings-rail"]') {
        if (rule.parent?.type !== "atrule") {
          rule.walkDecls((decl) => {
            if (decl.prop === "width") railWidth = decl.value
          })
        } else {
          rule.walkDecls((decl) => {
            if (decl.prop === "width") railNarrowWidth = decl.value
          })
        }
      }
    })

    expect(maxWidth).toBe("1100px")
    expect(width).toContain("1100px")
    expect(railWidth).toBe("220px")
    expect(railNarrowWidth).toBe("56px")
  })
})
