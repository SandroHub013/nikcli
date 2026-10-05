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
    /** Voice props on top of the defaults: the settings, MAI's state, the engine. */
    voice?: Record<string, unknown>
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
        ...options.voice,
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

    // S5: Voce ha la X e «Fatto» del guscio, come le altre categorie (A1)
    expect(document.body.querySelector('[data-slot="settings-close"]')).not.toBeNull()
    expect(document.body.querySelector('[data-slot="settings-done"]')).not.toBeNull()
    // …e niente del pannello vocale intero: né la sua testata né il suo menu.
    expect(document.body.querySelector('[data-component="voice-settings-panel"] [data-slot="rail"]')).toBeNull()
    expect(document.body.querySelector("#voice-panel-title")).toBeNull()

    dispose?.()
    document.body.innerHTML = ""
  })

  test("lint: settings-sheet.tsx non monta più il pannello vocale intero, ma le sue pagine (S5)", () => {
    const sheetCode = readFileSync(join(import.meta.dir, "settings-sheet.tsx"), "utf8")
    expect(sheetCode).not.toContain("<VoiceSettingsPanel")
    expect(sheetCode).not.toContain("extraSections")
    expect(sheetCode).toContain("<VoiceSettingsPage")
    expect(sheetCode).toContain("<VoiceStatusBar")
    expect(sheetCode).toContain("<VoiceListenButton")
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

    // Il foglio passa la vista alla vera pagina: questa la disegna davvero.
    // Montarla qui non è possibile (in `bun test` manca `import.meta.glob` dei
    // loghi, il ripiego è vietato), quindi si legge il sorgente: la prop
    // `view` comanda i tre rami `Show` e nessun tab interno resta.
    const page = readFileSync(join(import.meta.dir, "../extensions/extensions-page.tsx"), "utf-8")
    expect(page).toContain("const tab = () => props.view")
    expect(page).not.toContain("setTab")
    for (const view of ["catalogo", "installati", "plugin"]) {
      expect(page, `ramo ${view}`).toContain(`<Show when={tab() === "${view}"}>`)
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
    // Trovato o mancante, qui: il find ritorna undefined, mai null.
    const two = choiceTwo()
    expect(two).not.toBeUndefined()
    two!.click()
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

describe("S5: le pagine della voce nella categoria Voce", () => {
  const PROBES: Record<string, string> = {
    "voice/mode": '[data-slot="mode-grid"]',
    "voice/activation": '[data-slot="activation-list"]',
    "voice/shortcuts": "#agent-chord-btn",
    "voice/language": "#voice-language-select",
    "voice/devices": "#voice-input-device",
    "voice/recognition": '[data-slot="backend-list"]',
    "voice/reply": '[data-component="mai-box"]',
    "voice/commands": "#voice-trial-input",
  }

  test("ognuna delle 8 schede mostra la sua pagina, senza il pannello vocale intorno", () => {
    for (const [tab, probe] of Object.entries(PROBES)) {
      renderSettingsSheet({ initialTarget: tab })
      const page = document.body.querySelector(`[data-slot="settings-body"] section[data-page="${tab.slice(6)}"]`)
      expect(page, `pagina di ${tab}`).not.toBeNull()
      expect(page!.querySelector(probe), `contenuto di ${tab}`).not.toBeNull()
      expect(
        document.body.querySelector('[data-slot="settings-tab"][data-active="true"]')?.getAttribute("data-tab"),
      ).toBe(tab)
      // Il nome lo danno intestazione e schede: nessun h3 visibile nel corpo, nessun menu del pannello.
      expect(document.body.querySelector('[data-slot="section-title"]'), `h3 in ${tab}`).toBeNull()
      expect(document.body.querySelector('[data-slot="rail"]'), `menu del pannello in ${tab}`).toBeNull()
      // La barra della voce sta sopra la pagina; «Avvia ascolto» nel piede del guscio.
      const body = document.body.querySelector('[data-slot="settings-body"]')!
      expect(body.firstElementChild?.getAttribute("data-part")).toBe("status")
      expect(document.body.querySelector('[data-slot="settings-footer"] [data-slot="primary-btn"]')).not.toBeNull()
      dispose?.()
      document.body.innerHTML = ""
    }
  })

  test("le schede Voce condividono uno stato: un filtro scritto c'è ancora al ritorno", () => {
    renderSettingsSheet({ initialTarget: "voice/language" })
    const filter = document.body.querySelector<HTMLInputElement>("#voice-language-filter")!
    filter.value = "ital"
    filter.dispatchEvent(new Event("input", { bubbles: true }))
    document.body.querySelector<HTMLButtonElement>('[data-tab="voice/commands"]')!.click()
    expect(document.body.querySelector("#voice-language-filter")).toBeNull()
    document.body.querySelector<HTMLButtonElement>('[data-tab="voice/language"]')!.click()
    expect(document.body.querySelector<HTMLInputElement>("#voice-language-filter")!.value).toBe("ital")
  })

  test("la UI di MAI sta in Voce delle risposte e si comporta come prima", () => {
    const changes: { replyVoice?: string; replyVoiceOffer?: string }[] = []
    let retried = 0
    renderSettingsSheet({
      initialTarget: "voice/reply",
      voice: {
        voiceSettings: {
          ...DEFAULT_VOICE_SETTINGS,
          replyVoice: "ugo",
          replyBackend: "piper",
          openRouterApiKey: "sk-or-finta",
        },
        onVoiceSettingsChange: (next: { replyVoice?: string; replyVoiceOffer?: string }) => changes.push(next),
      },
    })
    document.body.querySelector<HTMLButtonElement>('[data-mai-offer="use"]')!.click()
    expect(changes.at(-1)?.replyVoice).toBe("it-IT-Rosa")
    expect(changes.at(-1)?.replyVoiceOffer).toBe("accepted")
    dispose?.()
    document.body.innerHTML = ""

    renderSettingsSheet({
      initialTarget: "voice/reply",
      voice: {
        voiceSettings: { ...DEFAULT_VOICE_SETTINGS, replyVoice: "it-IT-Rosa", openRouterApiKey: "sk-or-finta" },
        maiBlocked: "payment",
        onRetryMai: () => {
          retried++
        },
      },
    })
    document.body.querySelector<HTMLButtonElement>("[data-mai-retry]")!.click()
    expect(retried).toBe(1)
    // La scelta di Piper e Kokoro è qui anche lei, non più sotto Modalità.
    expect(document.body.querySelector("#reply-backend-label")).not.toBeNull()
  })

  test("Modalità non porta più la scelta della voce delle risposte", () => {
    renderSettingsSheet({ initialTarget: "voice/mode" })
    expect(document.body.querySelector("#reply-backend-label")).toBeNull()
    expect(document.body.querySelector("#agent-reply-label")).not.toBeNull()
  })

  test("«Avvia ascolto» nel piede accende la voce dello stesso engine", () => {
    let toggled = 0
    renderSettingsSheet({
      initialTarget: "voice",
      voice: {
        voiceEngine: {
          ...(fakeVoiceEngine as object),
          toggle: () => {
            toggled++
          },
        },
      },
    })
    const listen = document.body.querySelector<HTMLButtonElement>(
      '[data-slot="settings-footer"] [data-slot="primary-btn"]',
    )!
    expect(listen.textContent).toBe("Avvia ascolto")
    listen.click()
    expect(toggled).toBe(1)
  })

  test("VoiceSettingsPage si disegna da sola, senza guscio né barra", async () => {
    const { VoiceSettingsPage } = await import("@nikcli-ai/voice")
    const host = document.createElement("div")
    document.body.append(host)
    dispose = render(
      () =>
        createComponent(VoiceSettingsPage, {
          page: "reply",
          engine: fakeVoiceEngine,
          settings: { ...DEFAULT_VOICE_SETTINGS },
          onChange: () => {},
        }),
      host,
    )
    expect(host.querySelector('[data-component="mai-box"]')).not.toBeNull()
    expect(host.querySelector('[data-slot="section-title"]')?.textContent).toBe("Voce delle risposte")
    for (const chrome of [
      '[data-slot="header"]',
      '[data-slot="rail"]',
      '[data-slot="status-pill"]',
      '[data-slot="primary-btn"]',
    ]) {
      expect(host.querySelector(chrome), chrome).toBeNull()
    }
  })
})

describe("S6: la chiave OpenRouter sta in Chiavi API", () => {
  // La riga si vede con ogni backend: il ripiego batch e MAI spendono la chiave anche quando trascrive Grok.
  for (const backend of ["openrouter", "grok-stream"] as const) {
    test(`Riconoscimento (${backend}): niente campo della chiave, una riga di stato e il collegamento a Chiavi API`, () => {
      let managed = 0
      renderSettingsSheet({
        initialTarget: "voice/recognition",
        voice: {
          voiceSettings: { ...DEFAULT_VOICE_SETTINGS, backend, openRouterApiKey: "sk-or-finta-0000abcd" },
          onManageKeys: () => {
            managed++
          },
        },
      })
      const row = document.body.querySelector("[data-key-status]")
      expect(row).not.toBeNull()
      expect(row!.textContent).toContain("abcd")
      expect(row!.textContent).not.toContain("sk-or-finta")
      expect(document.body.querySelector("#openrouter-key-field")).toBeNull()
      expect(document.body.querySelector('[data-slot="settings-body"] input[type="password"]')).toBeNull()
      document.body.querySelector<HTMLButtonElement>("[data-manage-keys]")!.click()
      expect(managed).toBe(1)
    })

    test(`Riconoscimento (${backend}): senza chiave la riga lo dice`, () => {
      renderSettingsSheet({
        initialTarget: "voice/recognition",
        voice: { voiceSettings: { ...DEFAULT_VOICE_SETTINGS, backend } },
      })
      expect(document.body.querySelector("[data-key-status]")?.textContent).toContain("Nessuna chiave OpenRouter")
    })
  }

  test("in conflitto, Chiavi API chiede quale chiave tenere e passa la risposta", async () => {
    const answers: string[] = []
    renderSettingsSheet({
      initialTarget: "agents/keys",
      voice: {
        voiceKeyConflict: async (choice: string) => {
          answers.push(choice)
        },
      },
    })
    document.body.querySelector<HTMLButtonElement>('[data-voice-conflict="voice"]')!.click()
    document.body.querySelector<HTMLButtonElement>('[data-voice-conflict="keychain"]')!.click()
    expect(answers).toEqual(["voice", "keychain"])
  })

  test("senza conflitto, Chiavi API non chiede niente", () => {
    renderSettingsSheet({ initialTarget: "agents/keys" })
    expect(document.body.querySelector("[data-voice-conflict]")).toBeNull()
  })
})

describe("T5b: lo streaming in Riconoscimento", () => {
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
  const recognition = (voice: Record<string, unknown>) =>
    renderSettingsSheet({ initialTarget: "voice/recognition", voice })
  const status = () => document.body.querySelector('[data-stream="status"]')?.textContent
  const grok = { ...DEFAULT_VOICE_SETTINGS, backend: "grok-stream" as const, openRouterApiKey: "sk-or-finta-0000abcd" }

  test("due motori da scegliere: Grok in tempo reale e MAI-Transcribe-2; un clic passa a MAI", () => {
    const changes: { backend: string }[] = []
    recognition({ voiceSettings: grok, onVoiceSettingsChange: (next: { backend: string }) => changes.push(next) })
    const radios = [...document.body.querySelectorAll('[data-slot="backend-list"] [role="radio"]')]
    expect(radios.map((radio) => radio.getAttribute("data-value"))).toEqual(["grok-stream", "openrouter"])
    expect(radios[0]!.getAttribute("aria-checked")).toBe("true")
    expect(radios[0]!.textContent).toContain("Grok in tempo reale (xAI)")
    expect(radios[1]!.textContent).toContain("MAI-Transcribe-2 (OpenRouter)")
    ;(radios[1] as HTMLElement).click()
    expect(changes.at(-1)?.backend).toBe("openrouter")
  })

  test("streaming scelto senza chiave xAI: lo dice, e trascrive MAI-Transcribe-2", () => {
    recognition({ voiceSettings: grok, xaiKeyMasked: null })
    expect(status()).toBe("Streaming: nessuna chiave xAI, trascrivo con MAI-Transcribe-2")
  })

  test("con la chiave xAI dice lo streaming attivo con la coda della chiave; rifiutata, il motivo e «Riprova»", () => {
    let retried = 0
    recognition({
      voiceSettings: grok,
      xaiKeyMasked: "••••wxyz",
      streamState: { kind: "auth" },
      onRetryStream: () => {
        retried++
      },
    })
    expect(status()).toBe("Chiave xAI rifiutata: trascrivo con MAI-Transcribe-2")
    document.body.querySelector<HTMLButtonElement>("[data-stream-retry]")!.click()
    expect(retried).toBe(1)
    dispose?.()
    document.body.innerHTML = ""
    recognition({ voiceSettings: grok, xaiKeyMasked: "••••wxyz", onRetryStream: () => {} })
    expect(status()).toBe("Streaming attivo, chiave xAI ••••wxyz")
    expect(document.body.querySelector("[data-stream-retry]")).toBeNull()
  })

  test("il tetto del giorno si cambia qui, fra 0 e 5 dollari", () => {
    const changes: { streamDailyCapUsd: number }[] = []
    recognition({
      voiceSettings: grok,
      xaiKeyMasked: "••••wxyz",
      onVoiceSettingsChange: (next: { streamDailyCapUsd: number }) => changes.push(next),
    })
    const input = document.body.querySelector<HTMLInputElement>("#voice-stream-cap")!
    expect(input.value).toBe("0.5")
    input.value = "1,25"
    input.dispatchEvent(new Event("change", { bubbles: true }))
    expect(changes.at(-1)?.streamDailyCapUsd).toBe(1.25)
    input.value = "9"
    input.dispatchEvent(new Event("change", { bubbles: true }))
    expect(changes.at(-1)?.streamDailyCapUsd).toBe(5)
    const before = changes.length
    input.value = "abc"
    input.dispatchEvent(new Event("change", { bubbles: true }))
    expect(changes).toHaveLength(before)
  })

  test("il tetto non si mostra con MAI-Transcribe-2 scelto", () => {
    recognition({ voiceSettings: { ...grok, backend: "openrouter" } })
    expect(document.body.querySelector("#voice-stream-cap")).toBeNull()
    expect(status()).toBe("Trascrive MAI-Transcribe-2, a frase finita")
  })

  test("la spesa del giorno tiene lo streaming separato dal resto", () => {
    recognition({
      voiceSettings: grok,
      voiceEngine: {
        ...(fakeVoiceEngine as object),
        listenSpend: () => ({ day: "2026-10-05", calls: 3, cost: 0.02, streamSeconds: 600, streamCost: 0.04 }),
      },
    })
    const spend = document.body.querySelector('[data-stream="spend"]')!.textContent!
    const other = document.body.querySelector('[data-stream="spend-other"]')!.textContent!
    expect(spend).toContain("10 min")
    expect(spend).toContain("0,04")
    expect(other).toContain("3 richieste")
    expect(other).toContain("0,02")
    expect(other).not.toContain("0,04")
  })

  test("senza la chiave OpenRouter una riga dice che la voce non parte, anche con la chiave xAI (B3)", () => {
    recognition({ voiceSettings: { ...grok, openRouterApiKey: undefined }, xaiKeyMasked: "••••wxyz" })
    expect(document.body.querySelector("[data-needs-openrouter]")?.textContent).toBe(
      "Senza la chiave OpenRouter la voce non parte, anche con la chiave xAI.",
    )
    dispose?.()
    document.body.innerHTML = ""
    recognition({ voiceSettings: grok, xaiKeyMasked: "••••wxyz" })
    expect(document.body.querySelector("[data-needs-openrouter]")).toBeNull()
  })

  test("il testo lungo sta in «Come funziona», chiuso finché non lo si apre", () => {
    recognition({ voiceSettings: grok })
    expect(document.body.textContent).not.toContain("0,20 $ l'ora")
    const toggle = [...document.body.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Come funziona"),
    )!
    toggle.click()
    expect(document.body.textContent).toContain("0,20 $ l'ora")
  })
})

describe("T5b: la chiave xAI in Chiavi API", () => {
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
  /** Un portachiavi finto: nomi e code mascherate, valori mai restituiti. */
  const fakeKeys = (initial: { name: string; env: string; masked?: string }[]) => {
    const keys = initial.map((key) => ({ ...key, agents: [] as string[], createdMs: 0 }))
    const saved: { name: string; env: string; agents: readonly string[]; value?: string }[] = []
    const removed: string[] = []
    const host = {
      list: async () => keys.map((key) => ({ ...key })),
      save: async (draft: { name: string; env: string; agents: readonly string[]; value?: string }) => {
        saved.push(draft)
        keys.push({
          name: draft.name,
          env: draft.env,
          masked: "••••" + draft.value!.slice(-4),
          agents: [],
          createdMs: 0,
        })
      },
      remove: async (name: string) => {
        removed.push(name)
        keys.splice(
          keys.findIndex((key) => key.name === name),
          1,
        )
      },
      copy: async () => 30,
    }
    return { host, saved, removed }
  }
  const block = () => document.body.querySelector("[data-xai-key]")

  test("senza chiave: un campo password e «Salva», che salva «xAI» su XAI_API_KEY per nessun agente", async () => {
    const keys = fakeKeys([{ name: "OpenRouter", env: "OPENROUTER_API_KEY", masked: "••••abcd" }])
    renderSettingsSheet({ initialTarget: "agents/keys", voice: { keysHost: () => keys.host } })
    await tick()
    const field = block()!.querySelector<HTMLInputElement>('input[type="password"][data-xai-input]')!
    field.value = "xai-finta-1234"
    block()!
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
    await tick()
    await tick()
    expect(keys.saved).toEqual([{ name: "xAI", env: "XAI_API_KEY", agents: [], value: "xai-finta-1234" }])
    expect(block()!.querySelector("[data-xai-input]")).toBeNull()
    expect(block()!.textContent).toContain("Salvata (••••1234)")
    expect(block()!.textContent).not.toContain("xai-finta")
  })

  test("salvata: dice se la usa la trascrizione o se è stata rifiutata", async () => {
    const keys = fakeKeys([{ name: "xAI", env: "XAI_API_KEY", masked: "••••wxyz" }])
    renderSettingsSheet({
      initialTarget: "agents/keys",
      voice: { keysHost: () => keys.host, voiceSettings: { ...DEFAULT_VOICE_SETTINGS, backend: "grok-stream" } },
    })
    await tick()
    expect(block()!.querySelector("[data-xai-status]")?.textContent).toBe("Salvata (••••wxyz)Usata dalla trascrizione")
    dispose?.()
    document.body.innerHTML = ""
    renderSettingsSheet({
      initialTarget: "agents/keys",
      voice: {
        keysHost: () => keys.host,
        voiceSettings: { ...DEFAULT_VOICE_SETTINGS, backend: "grok-stream" },
        streamState: { kind: "auth" },
      },
    })
    await tick()
    expect(block()!.querySelector("[data-xai-status]")?.getAttribute("data-xai-status")).toBe("refused")
    expect(block()!.textContent).toContain("Rifiutata")
  })

  test("«Rimuovi» chiede conferma con le parole giuste, e solo «Togli» la toglie", async () => {
    const keys = fakeKeys([{ name: "xAI", env: "XAI_API_KEY", masked: "••••wxyz" }])
    renderSettingsSheet({ initialTarget: "agents/keys", voice: { keysHost: () => keys.host } })
    await tick()
    block()!.querySelector<HTMLButtonElement>("[data-xai-remove]")!.click()
    expect(block()!.querySelector("[data-xai-confirm]")?.textContent).toContain(
      "Togliere la chiave xAI? La trascrizione torna a MAI-Transcribe-2.",
    )
    block()!.querySelector<HTMLButtonElement>("[data-xai-remove-no]")!.click()
    expect(keys.removed).toEqual([])
    block()!.querySelector<HTMLButtonElement>("[data-xai-remove]")!.click()
    block()!.querySelector<HTMLButtonElement>("[data-xai-remove-yes]")!.click()
    await tick()
    await tick()
    expect(keys.removed).toEqual(["xAI"])
    expect(block()!.querySelector("[data-xai-input]")).not.toBeNull()
  })
})

describe("settings shell: the frame holds the panel", () => {
  const rule = (selector: string) => {
    const parsed = postcss.parse(readFileSync(join(import.meta.dir, "shell.css"), "utf-8"))
    let found: postcss.Rule | undefined
    parsed.walkRules((candidate) => {
      if (candidate.selector === selector && candidate.parent?.type !== "atrule") found = candidate
    })
    return found
  }
  const decl = (r: postcss.Rule | undefined, prop: string) => {
    let value: string | undefined
    r?.walkDecls(prop, (d) => {
      value = d.value
    })
    return value
  }

  test("the sheet's frame is as wide as the shell, not the 560px of a bare frame", () => {
    renderSettingsSheet()
    // The selector in the CSS is the structure the sheet really renders.
    const frame = document.body.querySelector('[data-component="settings-sheet"] [data-layout="frame"]')
    expect(frame, "il frame dentro la sheet delle impostazioni").not.toBeNull()
    expect(frame?.querySelector('[data-component="settings-shell"]')).not.toBeNull()

    const frameRule = rule('[data-component="settings-sheet"] [data-layout="frame"]')
    expect(frameRule, "la regola che allarga il frame").not.toBeUndefined()
    // The same number as the shell's own limit: one cannot grow without the other.
    expect(decl(frameRule, "--ade-surface-max")).toBe("1100px")
    expect(decl(rule(".settings-shell"), "max-width")).toBe("1100px")
  })

  test("below 1148px the shell takes the window less its gutters, inside the frame", () => {
    // The frame is the window less the overlay's side padding (one gutter each side); the shell is narrower still.
    expect(decl(rule(".settings-shell"), "width")).toBe("min(1100px, calc(100vw - 2 * var(--space-6, 24px)))")
    expect(decl(rule(".settings-shell"), "height")).toBe("min(90vh, calc(100vh - 2 * var(--space-6, 24px)))")
  })

  test("the sheet is centred, so a 90vh panel is not pushed below the window by the overlay's top padding", () => {
    renderSettingsSheet()
    const overlay = document.body.querySelector('[data-component="settings-sheet"]')
    expect(overlay?.getAttribute("data-place")).toBe("center")
  })
})
