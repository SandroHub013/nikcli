import { afterEach, describe, expect, mock, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { compileSolidJsx } from "../test-support/solid-jsx"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import postcss from "postcss"
import { SETTINGS_VIEW_STORAGE_KEY, readLastView } from "./categories"

if (typeof document === "undefined") GlobalRegistrator.register()
compileSolidJsx()

mock.module("../extensions/extensions-page", () => ({
  ExtensionsPage: (props: { view?: string }) => {
    const el = document.createElement("div")
    el.dataset.component = "extensions-page"
    if (props.view) el.dataset.view = props.view
    return el
  },
}))

const { createComponent, render } = await import("solid-js/web")
const { SettingsSheet } = await import("./settings-sheet")
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

/*
 * What the fake workbench recorded from the settings panel: the recording
 * functions and the update flow, so a test can prove the sheet handed its
 * controls to the same callbacks the palette commands run.
 */
const calls = {
  quality: [] as string[],
  mic: [] as boolean[],
  folder: 0,
  export: 0,
  check: 0,
  install: 0,
}
let gridColumns: number | undefined = 1
let availableUpdate: { version: string } | undefined

afterEach(() => {
  calls.quality = []
  calls.mic = []
  calls.folder = 0
  calls.export = 0
  calls.check = 0
  calls.install = 0
  gridColumns = 1
  availableUpdate = undefined
})

function renderSettingsSheet(
  options: {
    initialTarget?: string
    onClose?: () => void
    version?: string
  } = {},
) {
  const host = document.createElement("div")
  document.body.append(host)
  const onClose = options.onClose ?? (() => {})

  dispose = render(
    () =>
      createComponent(SettingsSheet, {
        initialTarget: options.initialTarget,
        onClose,
        version: options.version,
        voiceEngine: fakeVoiceEngine,
        voiceSettings: { ...DEFAULT_VOICE_SETTINGS },
        onVoiceSettingsChange: () => {},
        onCheckUpdates: () => {
          calls.check++
        },
        themeState: {
          preference: () => "dark" as const,
          set: () => {},
          glassOpacity: () => 1,
          setGlassOpacity: () => {},
        },
        wb: () => ({ panes: [], pinnedColumns: gridColumns }) as never,
        setWb: (fn) => {
          const next = fn({ panes: [], pinnedColumns: gridColumns } as never) as {
            pinnedColumns: number | undefined
          }
          gridColumns = next.pinnedColumns
        },
        hookHost: () => ({ hasScript: () => false }) as never,
        hookStates: () => ({}),
        refreshHooks: () => {},
        openLoginSession: () => {},
        keysHost: () => undefined,
        extensionsIo: () => undefined,
        pluginRuntime: { registry: { sections: () => [] } } as never,
        openGuide: () => {},
        openFramePluginPane: () => {},
        askYesNo: async () => true,
        record: {
          quality: () => "alta" as const,
          onQuality: (next) => {
            calls.quality.push(next)
          },
          mic: () => false,
          onMic: (next) => {
            calls.mic.push(next)
          },
          dir: () => undefined,
          onPickFolder: () => {
            calls.folder++
          },
          onExport: () => {
            calls.export++
          },
        },
        updates: {
          checking: () => false,
          available: () => availableUpdate,
          onInstall: () => {
            calls.install++
          },
        },
      }),
    host,
  )
  return host
}

describe("settings shell", () => {
  test("la rotella apre l'ultima vista salvata o Generale come fallback", () => {
    // 1. Senza vista salvata -> fallback a Generale
    renderSettingsSheet()
    let activeCat = document.body.querySelector('[data-slot="category-button"][data-active="true"]')
    expect(activeCat).not.toBeNull()
    expect(activeCat?.getAttribute("data-category")).toBe("general")
    dispose?.()
    document.body.innerHTML = ""

    // 2. Con vista salvata in localStorage -> apre quella vista
    localStorage.setItem(SETTINGS_VIEW_STORAGE_KEY, JSON.stringify({ category: "agents", tab: "agents/keys" }))
    renderSettingsSheet()
    activeCat = document.body.querySelector('[data-slot="category-button"][data-active="true"]')
    expect(activeCat).not.toBeNull()
    expect(activeCat?.getAttribute("data-category")).toBe("agents")
    const activeTab = document.body.querySelector('[data-slot="settings-tab"][data-active="true"]')
    expect(activeTab).not.toBeNull()
    expect(activeTab?.getAttribute("data-tab")).toBe("agents/keys")
    dispose?.()
    document.body.innerHTML = ""
  })

  test("legacyTarget e voice.settings aprono la scheda corrispondente", () => {
    // voice-sec-backend -> voice
    renderSettingsSheet({ initialTarget: "voice-sec-backend" })
    let activeCat = document.body.querySelector('[data-slot="category-button"][data-active="true"]')
    expect(activeCat).not.toBeNull()
    expect(activeCat?.getAttribute("data-category")).toBe("voice")
    dispose?.()
    document.body.innerHTML = ""

    // voice.settings -> voice
    renderSettingsSheet({ initialTarget: "voice-sec-mode" })
    activeCat = document.body.querySelector('[data-slot="category-button"][data-active="true"]')
    expect(activeCat).not.toBeNull()
    expect(activeCat?.getAttribute("data-category")).toBe("voice")
    dispose?.()
    document.body.innerHTML = ""

    // set-sec-provider -> agents / agents/account
    renderSettingsSheet({ initialTarget: "set-sec-provider" })
    activeCat = document.body.querySelector('[data-slot="category-button"][data-active="true"]')
    expect(activeCat).not.toBeNull()
    expect(activeCat?.getAttribute("data-category")).toBe("agents")
    let activeTab = document.body.querySelector('[data-slot="settings-tab"][data-active="true"]')
    expect(activeTab).not.toBeNull()
    expect(activeTab?.getAttribute("data-tab")).toBe("agents/account")
    dispose?.()
    document.body.innerHTML = ""

    // set-sec-routine -> fallback a Generale
    renderSettingsSheet({ initialTarget: "set-sec-routine" })
    activeCat = document.body.querySelector('[data-slot="category-button"][data-active="true"]')
    expect(activeCat).not.toBeNull()
    expect(activeCat?.getAttribute("data-category")).toBe("general")
    dispose?.()
    document.body.innerHTML = ""
  })

  test("dopo un cambio di categoria o scheda, la vista salvata in localStorage si aggiorna", () => {
    renderSettingsSheet()
    expect(readLastView()).toEqual({ category: "general", tab: "general/appearance" })

    // Clic su Agenti
    const agentsBtn = document.body.querySelector<HTMLButtonElement>(
      '[data-slot="category-button"][data-category="agents"]',
    )
    expect(agentsBtn).not.toBeNull()
    agentsBtn!.click()

    expect(readLastView()).toEqual({ category: "agents", tab: "agents/account" })

    // Clic sulla scheda Chiavi API
    const keysTab = document.body.querySelector<HTMLButtonElement>('[data-slot="settings-tab"][data-tab="agents/keys"]')
    expect(keysTab).not.toBeNull()
    keysTab!.click()

    expect(readLastView()).toEqual({ category: "agents", tab: "agents/keys" })
  })

  test("se la versione non c'è, lo slot di versione non compare nel DOM (B1)", () => {
    // 1. Senza versione: nessun elemento nel DOM
    renderSettingsSheet({ version: undefined })
    expect(document.body.querySelector('[data-slot="settings-version"]')).toBeNull()
    dispose?.()
    document.body.innerHTML = ""

    // 2. Con versione: elemento presente con testo esatto
    renderSettingsSheet({ version: "1.406.0" })
    const versionEl = document.body.querySelector('[data-slot="settings-version"]')
    expect(versionEl).not.toBeNull()
    expect(versionEl?.textContent).toBe("ADE 1.406.0")
  })

  test("Esc chiude il pannello delle impostazioni tramite Kobalte (B2)", () => {
    let closed = false
    renderSettingsSheet({
      onClose: () => {
        closed = true
      },
    })
    const shellEl = document.body.querySelector<HTMLElement>('[data-component="settings-shell"]')
    expect(shellEl).not.toBeNull()

    // Dispatch di Escape su document: Kobalte Dialog chiude il foglio
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))
    expect(closed).toBe(true)
  })

  test("A1: dentro Voce durante la registrazione di una scorciatoia Esc non chiude le Impostazioni", () => {
    let closed = false
    renderSettingsSheet({
      initialTarget: "voice-sec-shortcuts",
      onClose: () => {
        closed = true
      },
    })

    const recorderBtn = document.body.querySelector<HTMLButtonElement>('[data-slot="shortcut-recorder-btn"]')
    expect(recorderBtn).not.toBeNull()
    expect(recorderBtn!.getAttribute("data-recording")).toBeNull()

    // Inizia la registrazione della scorciatoia
    recorderBtn!.click()
    expect(recorderBtn!.getAttribute("data-recording")).toBe("true")

    // Pressione di Escape durante la registrazione: ferma la registrazione e NON chiude il pannello
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))
    expect(closed).toBe(false)
    expect(recorderBtn!.getAttribute("data-recording")).toBeNull()

    // Pressione di Escape successiva a riposo: chiude il pannello
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))
    expect(closed).toBe(true)
  })

  test("le frecce muovono il fuoco nel menu e nelle schede", () => {
    renderSettingsSheet()
    const categoryButtons = [...document.body.querySelectorAll<HTMLButtonElement>('[data-slot="category-button"]')]
    expect(categoryButtons.length).toBe(6)

    // Focus prima categoria (Generale)
    categoryButtons[0]!.focus()

    // ArrowDown -> Agenti
    categoryButtons[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }))
    expect(document.activeElement).toBe(categoryButtons[1]!)

    // ArrowUp -> Generale (wraps)
    categoryButtons[1]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }))
    expect(document.activeElement).toBe(categoryButtons[0]!)

    // End -> Sistema (ultima)
    categoryButtons[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }))
    expect(document.activeElement).toBe(categoryButtons[5]!)

    // Home -> Generale (prima)
    categoryButtons[5]!.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }))
    expect(document.activeElement).toBe(categoryButtons[0]!)

    // Navigazione schede (tab)
    const tabButtons = [...document.body.querySelectorAll<HTMLButtonElement>('[data-slot="settings-tab"]')]
    expect(tabButtons.length).toBeGreaterThan(1)

    tabButtons[0]!.focus()
    // ArrowRight -> tab successiva
    tabButtons[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }))
    expect(document.activeElement).toBe(tabButtons[1]!)

    // ArrowLeft -> tab precedente
    tabButtons[1]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }))
    expect(document.activeElement).toBe(tabButtons[0]!)
  })

  test("in nessuna categoria tranne Voce ci sono status-pill, Avvia ascolto o Ripristina la voce (M1)", () => {
    // 1. Nelle categorie diverse da Voce (Generale, Agenti, Estensioni, Registrazione, Sistema)
    for (const catId of ["general", "agents", "extensions", "record", "system"]) {
      renderSettingsSheet({ initialTarget: catId })

      // Status pill non deve esistere
      const statusPill = document.body.querySelector('[data-slot="status-pill"]')
      expect(statusPill).toBeNull()

      // Il pulsante di ascolto non deve esistere
      const listenBtn = [...document.body.querySelectorAll("button")].find(
        (b) => b.textContent?.includes("Avvia ascolto") || b.getAttribute("data-action") === "voice.listen",
      )
      expect(listenBtn).toBeUndefined()

      // Il pulsante di ripristino voce non deve esistere
      const resetBtn = [...document.body.querySelectorAll("button")].find((b) =>
        b.textContent?.includes("Ripristina la voce"),
      )
      expect(resetBtn).toBeUndefined()

      // Il pulsante Fatto deve esistere ed essere non nullo
      const doneBtn = document.body.querySelector('[data-slot="settings-done"]')
      expect(doneBtn).not.toBeNull()

      dispose?.()
      document.body.innerHTML = ""
    }

    // 2. Nella categoria Voce: status pill, pulsante ascolto, ripristino, chiudi X e Fatto esistono
    renderSettingsSheet({ initialTarget: "voice" })
    const statusPill = document.body.querySelector('[data-slot="status-pill"]')
    expect(statusPill).not.toBeNull()

    const listenBtn = [...document.body.querySelectorAll("button")].find(
      (b) => b.textContent?.includes("Avvia ascolto") || b.getAttribute("data-action") === "voice.listen",
    )
    expect(listenBtn).not.toBeUndefined()

    const resetBtn = [...document.body.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Ripristina la voce"),
    )
    expect(resetBtn).not.toBeUndefined()

    // In Voce, framed garantisce che ci siano la X e Fatto (A1)
    const closeBtn = document.body.querySelector('[data-slot="close-btn"]')
    expect(closeBtn).not.toBeNull()

    const voiceDoneBtn = document.body.querySelector('[data-slot="solid-btn"]')
    expect(voiceDoneBtn).not.toBeNull()

    dispose?.()
    document.body.innerHTML = ""
  })

  test("lint: VoiceSettingsPanel è montato solo nel case 'voice' di settings-sheet.tsx ed ha framed senza inline", () => {
    const sheetCode = readFileSync(join(import.meta.dir, "settings-sheet.tsx"), "utf8")
    const matches = [...sheetCode.matchAll(/<VoiceSettingsPanel\b([\s\S]*?)\/>/g)]
    expect(matches.length).toBe(1)
    const panelProps = matches[0]![1]!
    expect(panelProps.includes("framed")).toBe(true)
    expect(panelProps.includes("inline")).toBe(false)

    // Verifica che stia dentro case "voice":
    const caseVoiceIndex = sheetCode.indexOf('case "voice":')
    expect(caseVoiceIndex).toBeGreaterThan(-1)
    const panelIndex = sheetCode.indexOf("<VoiceSettingsPanel")
    expect(panelIndex).toBeGreaterThan(caseVoiceIndex)
    const caseGeneralIndex = sheetCode.indexOf('case "general":')
    expect(panelIndex).toBeLessThan(caseGeneralIndex)
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

  test("M2: ogni scheda di Generale, Registrazione e Sistema apre con contenuto e senza h3 vecchio", () => {
    const cases: { tab: string; probe: string }[] = [
      { tab: "general/appearance", probe: "[data-theme-choice]" },
      { tab: "general/language", probe: '[data-slot="settings-choice"]' },
      { tab: "general/grid", probe: '[data-slot="settings-choice"]' },
      { tab: "record/video", probe: "[data-quality]" },
      { tab: "system/updates", probe: '[data-action="update.check"]' },
    ]
    for (const item of cases) {
      renderSettingsSheet({ initialTarget: item.tab, version: "1.406.0" })
      // Il contenuto della scheda c'è davvero: non un corpo vuoto.
      expect(document.body.querySelector(item.probe), `contenuto di ${item.tab}`).not.toBeNull()
      expect(document.body.querySelector('[data-slot="section-desc"]'), `descrizione di ${item.tab}`).not.toBeNull()
      // B4: il nome lo danno intestazione e barra delle schede, non un h3 nel corpo.
      expect(document.body.querySelector('[data-slot="section-title"]'), `h3 in ${item.tab}`).toBeNull()
      dispose?.()
      document.body.innerHTML = ""
    }
  })

  test("M2: le tre schede Estensioni mostrano tre viste distinte della stessa pagina", () => {
    const views: { tab: string; view: string }[] = [
      { tab: "extensions/installed", view: "installati" },
      { tab: "extensions/mcp", view: "catalogo" },
      { tab: "extensions/plugins", view: "plugin" },
    ]
    for (const item of views) {
      renderSettingsSheet({ initialTarget: item.tab })
      const page = document.body.querySelector('[data-component="extensions-page"]')
      expect(page, `pagina di ${item.tab}`).not.toBeNull()
      expect(page?.getAttribute("data-view"), `vista di ${item.tab}`).toBe(item.view)
      dispose?.()
      document.body.innerHTML = ""
    }
  })

  test("M2: Registrazione video chiama le stesse funzioni dei comandi record.*", () => {
    renderSettingsSheet({ initialTarget: "record/video" })

    // La qualità passa dalla stessa callback di record.quality
    const media = document.body.querySelector<HTMLButtonElement>('[data-quality="media"]')
    expect(media).not.toBeNull()
    media!.click()
    expect(calls.quality).toEqual(["media"])

    // Il microfono passa dalla stessa callback di record.mic
    const micOff = document.body.querySelector<HTMLButtonElement>('[data-mic="off"]')
    expect(micOff).not.toBeNull()
    micOff!.click()
    expect(calls.mic).toEqual([false])

    // La cartella apre lo stesso dialogo di record.folder
    const folderBtn = document.body.querySelector<HTMLButtonElement>('[data-slot="settings-row"] button')
    expect(folderBtn).not.toBeNull()
    folderBtn!.click()
    expect(calls.folder).toBe(1)

    // L'esportazione parte dalla stessa funzione di record.export
    const exportBtn = document.body.querySelector<HTMLButtonElement>('[data-action="record.export"]')
    expect(exportBtn).not.toBeNull()
    exportBtn!.click()
    expect(calls.export).toBe(1)
  })

  test("M2: Aggiornamenti mostra la versione e controlla lo stesso flusso del menu", () => {
    renderSettingsSheet({ initialTarget: "system/updates", version: "1.406.0" })

    // La versione installata è quella reale, non un segnaposto
    expect(document.body.textContent ?? "").toContain("1.406.0")

    const checkBtn = document.body.querySelector<HTMLButtonElement>('[data-action="update.check"]')
    expect(checkBtn).not.toBeNull()
    expect(checkBtn!.disabled).toBe(false)
    checkBtn!.click()
    expect(calls.check).toBe(1)

    // La stessa controparte della campanella nel menu: una sola funzione
    const footerBtn = document.body.querySelector<HTMLButtonElement>('[data-slot="settings-check-update"]')
    expect(footerBtn).not.toBeNull()
    footerBtn!.click()
    expect(calls.check).toBe(2)

    // Nessun rilascio trovato: nessuna riga di installazione
    expect(document.body.querySelector('[data-action="update.install"]')).toBeNull()
  })

  test("M2: quando il controllo trova un rilascio, la scheda lo mostra e installa", () => {
    availableUpdate = { version: "9.9.9" }
    renderSettingsSheet({ initialTarget: "system/updates" })

    const notice = document.body.querySelector('[data-slot="settings-notice"]')
    expect(notice).not.toBeNull()
    expect(notice?.textContent ?? "").toContain("9.9.9")

    const installBtn = document.body.querySelector<HTMLButtonElement>('[data-action="update.install"]')
    expect(installBtn).not.toBeNull()
    installBtn!.click()
    expect(calls.install).toBe(1)
  })

  test("B4: la scelta della griglia sopravvive alla riapertura del foglio", () => {
    renderSettingsSheet({ initialTarget: "general/grid" })
    const choiceTwo = () =>
      [...document.body.querySelectorAll<HTMLButtonElement>('[data-slot="settings-choice"]')].find(
        (button) => button.textContent?.trim() === "2",
      )
    expect(choiceTwo()).toBeDefined()
    choiceTwo()!.click()
    expect(gridColumns).toBe(2)
    dispose?.()
    document.body.innerHTML = ""

    // Riaprendo, la stessa scelta è ancora attiva: il valore vive nel workbench
    renderSettingsSheet({ initialTarget: "general/grid" })
    expect(choiceTwo()?.getAttribute("data-active")).toBe("true")
  })

  test("S3: la vecchia sezione Routine e le sue chiavi i18n non esistono più", () => {
    const sections = readFileSync(join(import.meta.dir, "sections.tsx"), "utf-8")
    expect(sections).not.toContain("RoutineSection")
    const it = readFileSync(join(import.meta.dir, "../i18n/it.ts"), "utf-8")
    const en = readFileSync(join(import.meta.dir, "../i18n/en.ts"), "utf-8")
    for (const source of [it, en]) {
      expect(source).not.toContain('"settings.routine"')
      expect(source).not.toContain('"settings.routine.desc"')
      expect(source).not.toContain('"settings.routine.instead"')
    }
  })
})
