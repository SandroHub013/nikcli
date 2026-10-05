import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { compileSolidJsx } from "../test-support/solid-jsx"
import { readFileSync } from "node:fs"
import { join } from "node:path"

if (typeof document === "undefined") GlobalRegistrator.register()
compileSolidJsx()

mock.module("../extensions/extensions-page", () => ({
  ExtensionsPage: () => document.createElement("div"),
}))

/*
 * A fake host, never a real one: the status commands answer from a table, and
 * nothing here can open a login. `openLoginSession` is a recorder.
 */
type Answer = { lines: string[]; code: number }
let installed: Record<string, boolean> = {}
let answers: Record<string, Answer> = {}
let botFiles: Record<string, string> = {}

// A copy taken before the mock: the namespace object follows the mock once it is in place.
const realShell = { ...(await import("../host/shell")) }
const fakeHost = {
  probe: async (command: string) => (installed[command] ? `C:/fake/${command}.exe` : null),
  spawn: async (options: { command: string; onLine: (line: string) => void; onExit: (code: number) => void }) => {
    const answer = answers[options.command] ?? { lines: [], code: 1 }
    queueMicrotask(() => {
      for (const line of answer.lines) options.onLine(line)
      options.onExit(answer.code)
    })
    return { kill: () => {}, write: () => {}, resize: () => {} }
  },
  homeDir: async () => undefined,
  readDir: async (directory: string) => {
    if (!/\.nikcli[\\/]agent$/.test(directory)) throw new Error("no such directory")
    return Object.keys(botFiles).map((name) => ({ name, path: `${directory}/${name}`, is_dir: false, size: 1, modified_ms: 0 }))
  },
  readTextFile: async (path: string) => {
    const name = path.split(/[\\/]/).pop() ?? ""
    return { text: botFiles[name] ?? "", truncated: false, bytes: 1 }
  },
}
mock.module("../host/shell", () => ({ ...realShell, getHost: async () => fakeHost }))
afterAll(() => {
  mock.module("../host/shell", () => realShell)
})

const { createComponent, render } = await import("solid-js/web")
const { SettingsSheet } = await import("./settings-sheet")
const { DEFAULT_VOICE_SETTINGS } = await import("@nikcli-ai/voice/core")
const { HOOK_TARGETS } = await import("../session-new/agent-hooks")

let dispose: (() => void) | undefined
let logins: string[] = []
let hookStates: Record<string, unknown> = {}
let closed = 0

beforeEach(() => {
  installed = { claude: true, codex: true, nikcli: true }
  answers = {
    claude: { lines: ['{"loggedIn": true, "authMethod": "claude.ai"}'], code: 0 },
    codex: { lines: ["Not logged in"], code: 1 },
    nikcli: { lines: ["anthropic oauth"], code: 0 },
  }
  botFiles = {}
  logins = []
  hookStates = {}
  closed = 0
})

afterEach(() => {
  dispose?.()
  dispose = undefined
  document.body.innerHTML = ""
  localStorage.clear()
})

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 30))

function renderTab(tab: string) {
  const host = document.createElement("div")
  document.body.append(host)
  dispose = render(
    () =>
      createComponent(SettingsSheet, {
        initialTarget: tab,
        onClose: () => {
          closed++
        },
        voiceEngine: {
          isRunning: () => false,
          status: () => "idle",
          micLevel: () => 0,
          partialTranscript: () => "",
          lastSpoken: () => "",
          lastError: () => undefined,
          listenSpend: () => ({ calls: 0, cost: 0 }),
          toggle: () => {},
          cancel: () => {},
        } as never,
        voiceSettings: { ...DEFAULT_VOICE_SETTINGS },
        onVoiceSettingsChange: () => {},
        themeState: {
          preference: () => "dark" as const,
          set: () => {},
          glassOpacity: () => 1,
          setGlassOpacity: () => {},
        },
        project: () => ({ root: "/proj" }),
        wb: () => ({ panes: [], pinnedColumns: 1 }) as never,
        setWb: () => {},
        hookHost: () => ({ hasScript: () => false }) as never,
        hookStates: () => hookStates as never,
        refreshHooks: () => {},
        openLoginSession: (runner) => {
          logins.push(runner.id)
        },
        keysHost: () => undefined,
        extensionsIo: () => undefined,
        pluginRuntime: { registry: { sections: () => [] } } as never,
        openGuide: () => {},
        openFramePluginPane: () => {},
        askYesNo: async () => true,
        record: {
          quality: () => "alta" as const,
          onQuality: () => {},
          mic: () => false,
          onMic: () => {},
          dir: () => undefined,
          onPickFolder: () => {},
          onExport: () => {},
        },
        updates: { checking: () => false, available: () => undefined, onInstall: () => {} },
      }),
    host,
  )
}

const card = (runner: string) => document.body.querySelector(`[data-slot="provider-card"][data-runner="${runner}"]`)
const buttons = (runner: string) => [...(card(runner)?.querySelectorAll("button") ?? [])].map((b) => b.textContent?.trim())
const press = (element: Element | null | undefined) => {
  expect(element, "il pulsante da premere c'è").not.toBeNull()
  ;(element as HTMLElement).click()
}

describe("Agenti e account › Account", () => {
  test("ogni provider è una scheda, col pallino e il pulsante del suo stato", async () => {
    renderTab("agents/account")
    await settle()

    // Collegato: pallino verde, un solo pulsante «Cambia account».
    expect(card("claude")?.getAttribute("data-state")).toBe("connected")
    expect(card("claude")?.querySelector('[data-slot="status-label"]')?.textContent).toBe("Collegato")
    expect(buttons("claude")).toEqual(["Cambia account"])
    // Non collegato: ambra, «Accedi».
    expect(card("codex")?.getAttribute("data-state")).toBe("not-connected")
    expect(card("codex")?.querySelector('[data-slot="status-label"]')?.textContent).toBe("Non collegato")
    expect(buttons("codex")).toEqual(["Accedi"])
    // nikcli ha un provider: collegato.
    expect(card("nikcli")?.getAttribute("data-state")).toBe("connected")
    expect(document.body.querySelectorAll('[data-slot="provider-card"]').length).toBe(3)
  })

  test("non installato è grigio e senza pulsante; da controllare è ambra, col motivo nel tooltip", async () => {
    installed.codex = false
    answers.claude = { lines: ["???"], code: 0 }
    renderTab("agents/account")
    await settle()

    expect(card("codex")?.getAttribute("data-state")).toBe("not-installed")
    expect(card("codex")?.querySelector('[data-slot="status-label"]')?.textContent).toBe("Non installato")
    expect(buttons("codex")).toEqual([])

    expect(card("claude")?.getAttribute("data-state")).toBe("unverified")
    expect(card("claude")?.querySelector('[data-slot="status-label"]')?.textContent).toBe("Da verificare")
    expect(card("claude")?.querySelector('[data-slot="provider-badge"]')?.getAttribute("title")).toBe("???")
    expect(buttons("claude")).toEqual(["Accedi"])
  })

  test("i colori dei pallini sono token del tema: verde, ambra, grigio", () => {
    const css = readFileSync(join(import.meta.dir, "sections.css"), "utf-8")
    const dot = (state: string) =>
      css.match(new RegExp(`\\[data-state="${state}"\\] \\[data-slot="status-dot"\\][^{]*\\{([^}]*)\\}`))?.[1] ?? ""
    expect(dot("connected")).toContain("var(--ade-ansi-green)")
    expect(dot("not-connected")).toContain("var(--ade-ansi-yellow)")
    // Il grigio è il pallino senza stato: nessun colore fisso nel file.
    expect(css).toMatch(/\[data-slot="status-dot"\]\s*\{[^}]*var\(--ade-text-weak\)/)
    expect(css.slice(css.indexOf('[data-slot="account-cards"]'))).not.toMatch(/#[0-9a-f]{3,8}\b/i)
  })

  test("«Cambia account» chiede prima: il login non parte finché non si preme «Continua»", async () => {
    renderTab("agents/account")
    await settle()

    press(card("claude")?.querySelector('[data-action="switch"]'))
    expect(card("claude")?.querySelector('[data-slot="switch-prompt"]')?.textContent).toBe(
      "Si apre l'accesso di Claude Code. Continuare?",
    )
    expect(logins).toEqual([])

    // «Annulla» chiude la domanda e non lancia niente.
    press(card("claude")?.querySelector('[data-slot="switch-cancel"]'))
    expect(card("claude")?.querySelector('[data-slot="switch-prompt"]')).toBeNull()
    expect(buttons("claude")).toEqual(["Cambia account"])
    expect(logins).toEqual([])

    // «Continua» lancia il login di quel provider, una volta.
    press(card("claude")?.querySelector('[data-action="switch"]'))
    expect(logins).toEqual([])
    press(card("claude")?.querySelector('[data-slot="switch-continue"]'))
    expect(logins).toEqual(["claude"])
    expect(card("claude")?.querySelector('[data-slot="switch-prompt"]')).toBeNull()
  })

  test("Esc chiude solo la conferma; con la conferma chiusa chiude le Impostazioni", async () => {
    renderTab("agents/account")
    await settle()
    const escape = () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))

    press(card("claude")?.querySelector('[data-action="switch"]'))
    expect(card("claude")?.querySelector('[data-slot="switch-prompt"]')).not.toBeNull()

    escape()
    expect(card("claude")?.querySelector('[data-slot="switch-prompt"]'), "la domanda si chiude").toBeNull()
    expect(buttons("claude")).toEqual(["Cambia account"])
    expect(closed, "le Impostazioni restano aperte").toBe(0)
    expect(logins).toEqual([])

    // Senza domanda in piedi l'Esc è del foglio, come sempre.
    escape()
    expect(closed).toBe(1)
  })

  test("un doppio clic su «Cambia account» non preme «Continua»: il secondo clic non è una risposta", async () => {
    renderTab("agents/account")
    await settle()

    press(card("claude")?.querySelector('[data-action="switch"]'))
    const continueButton = card("claude")?.querySelector('[data-slot="switch-continue"]')
    expect(continueButton, "«Continua»").not.toBeNull()

    // Il secondo clic di un doppio clic arriva con detail 2, sul punto dove c'era «Cambia account».
    continueButton?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 2 }))
    expect(logins).toEqual([])
    expect(card("claude")?.querySelector('[data-slot="switch-prompt"]'), "la domanda resta").not.toBeNull()

    // Un clic o un Invio veri (detail 1 o 0) rispondono.
    continueButton?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }))
    expect(logins).toEqual(["claude"])
  })

  test("«Accedi» da «Da verificare» chiede conferma: l'account potrebbe esserci", async () => {
    answers.claude = { lines: ["???"], code: 0 }
    renderTab("agents/account")
    await settle()

    expect(card("claude")?.getAttribute("data-state")).toBe("unverified")
    press(card("claude")?.querySelector('[data-action="login"]'))
    expect(logins, "il login non parte al primo clic").toEqual([])
    expect(card("claude")?.querySelector('[data-slot="switch-prompt"]')?.textContent).toBe(
      "Si apre l'accesso di Claude Code. Continuare?",
    )
    press(card("claude")?.querySelector('[data-slot="switch-cancel"]'))
    expect(logins).toEqual([])
    expect(buttons("claude")).toEqual(["Accedi"])

    press(card("claude")?.querySelector('[data-action="login"]'))
    press(card("claude")?.querySelector('[data-slot="switch-continue"]'))
    expect(logins).toEqual(["claude"])
  })

  test("il fuoco segue la domanda: su «Annulla» quando si apre, sul pulsante quando si chiude", async () => {
    renderTab("agents/account")
    await settle()
    const tick = () => new Promise<void>((resolve) => queueMicrotask(resolve))

    press(card("claude")?.querySelector('[data-action="switch"]'))
    await tick()
    expect(document.activeElement).toBe(card("claude")?.querySelector('[data-slot="switch-cancel"]') ?? null)
    // Il gruppo è nominato dalla sua domanda.
    const group = card("claude")?.querySelector('[data-slot="switch-confirm"]')
    expect(document.getElementById(group?.getAttribute("aria-labelledby") ?? "")?.textContent).toBe(
      "Si apre l'accesso di Claude Code. Continuare?",
    )

    press(card("claude")?.querySelector('[data-slot="switch-cancel"]'))
    await tick()
    expect(document.activeElement).toBe(card("claude")?.querySelector('[data-action="switch"]') ?? null)

    // Anche con Esc il fuoco torna al pulsante.
    press(card("claude")?.querySelector('[data-action="switch"]'))
    await tick()
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))
    await tick()
    expect(document.activeElement).toBe(card("claude")?.querySelector('[data-action="switch"]') ?? null)
  })

  test("«Accedi» non chiede conferma: non c'è un account da perdere", async () => {
    renderTab("agents/account")
    await settle()
    press([...(card("codex")?.querySelectorAll("button") ?? [])][0])
    expect(logins).toEqual(["codex"])
  })

  test("«Come funziona» è chiuso all'apertura e `aria-expanded` cambia con il clic", async () => {
    renderTab("agents/account")
    await settle()

    const toggle = () => document.body.querySelector('[data-slot="how-it-works-toggle"]')
    expect(toggle(), "il pulsante «Come funziona»").not.toBeNull()
    expect(toggle()?.textContent?.trim()).toBe("Come funziona")
    expect(toggle()?.getAttribute("aria-expanded")).toBe("false")
    expect(document.body.querySelector('[data-slot="how-it-works-panel"]')).toBeNull()
    // Il muro di testo non è nella pagina finché non lo si apre.
    expect(document.body.textContent).not.toContain("codex login --with-api-key")

    press(toggle())
    expect(toggle()?.getAttribute("aria-expanded")).toBe("true")
    const panel = document.body.querySelector('[data-slot="how-it-works-panel"]')
    expect(panel, "il testo si apre").not.toBeNull()
    expect(panel?.textContent).toContain("codex login --with-api-key")
    expect(panel?.getAttribute("id")).toBe(toggle()?.getAttribute("aria-controls"))

    press(toggle())
    expect(toggle()?.getAttribute("aria-expanded")).toBe("false")
    expect(document.body.querySelector('[data-slot="how-it-works-panel"]')).toBeNull()
  })

  test("sopra le schede resta una frase sola, senza un h3 che ripete il nome della scheda", async () => {
    renderTab("agents/account")
    await settle()
    expect(document.body.querySelector('[data-slot="section-title"]')).toBeNull()
    expect(document.body.querySelectorAll('[data-slot="section-head"] [data-slot="section-desc"]').length).toBe(1)
  })
})

describe("Agenti e account › Bot e strumenti", () => {
  test("senza bot con limitazioni dice che non ce ne sono, non «Nessuno strumento», e come aggiungerne", async () => {
    renderTab("agents/bots")
    await settle()

    const body = document.body.textContent ?? ""
    // Nessuna limitazione vuol dire che ogni bot ha tutti gli strumenti: il contrario di «nessuno strumento».
    expect(body).toContain("Nessun bot ha limitazioni: tutti possono usare ogni strumento di nikcli.")
    expect(body).not.toContain("Nessuno strumento")
    expect(document.body.querySelectorAll('[data-slot="settings-hint"]').length).toBe(1)
    expect(body).toContain("Aggiungi o rimuovi limitazioni configurando il bot nella vista Bot.")
    expect(body).not.toContain('senza "*"')
    expect(body).not.toContain("senza *")
  })

  test("un bot a cui è tolto tutto mostra «Nessuno strumento», non `senza *`", async () => {
    botFiles = { "muto.md": '---\ndescription: muto\ntools:\n  "*": false\n---\nTacere.\n' }
    renderTab("agents/bots")
    await settle()

    const rows = [...document.body.querySelectorAll('[data-slot="settings-row"]')]
    const row = rows.find((r) => r.textContent?.includes("muto"))
    expect(row, "la riga del bot").not.toBeUndefined()
    // La stessa riga compare nell'elenco dei bot e in quello degli strumenti: serve quella degli strumenti.
    const restricted = rows.filter((r) => r.textContent?.includes("Nessuno strumento"))
    expect(restricted.length).toBe(1)
    expect(restricted[0]?.textContent).toContain("muto")
    expect(document.body.textContent).not.toContain("senza *")
    // Con una riga per bot il suggerimento non si ripete: una volta sola, sotto la lista.
    expect(document.body.querySelectorAll('[data-slot="settings-hint"]').length).toBe(1)
    expect(document.body.textContent).not.toContain("Nessun bot ha limitazioni")
  })

  test("Bot e Strumenti stanno nella stessa scheda, con due sottotitoli e nessun h3", async () => {
    renderTab("agents/bots")
    await settle()
    const subtitles = [...document.body.querySelectorAll('[data-slot="section-subtitle"]')].map((h) => h.textContent)
    expect(subtitles).toEqual(["Bot", "Strumenti"])
    expect(document.body.querySelector('[data-slot="section-title"]')).toBeNull()
  })
})

describe("Agenti e account › Ripresa delle sessioni", () => {
  const state = (id: string, over: Record<string, unknown>) => ({
    target: HOOK_TARGETS.find((target) => target.id === id)!,
    installed: false,
    broken: false,
    configPath: `C:/u/${id}.json`,
    scriptPath: `C:/u/${id}.ps1`,
    ...over,
  })

  test("una riga di stato in testa, e il testo lungo in «Come funziona» chiuso", async () => {
    hookStates = {
      "claude-code": state("claude-code", { installed: true }),
      codex: state("codex", {}),
      nikcli: state("nikcli", {}),
    }
    renderTab("agents/resume")
    await settle()

    expect(document.body.querySelector("[data-hooks-summary]")?.textContent).toBe(
      "Ripresa attiva per 1 programma su 3.",
    )
    const toggle = document.body.querySelector('[data-slot="how-it-works-toggle"]')
    expect(toggle?.getAttribute("aria-expanded")).toBe("false")
    expect(document.body.textContent).not.toContain("Al riavvio ADE riapre le sessioni")
    press(toggle)
    expect(document.body.querySelector('[data-slot="how-it-works-panel"]')?.textContent).toContain(
      "Al riavvio ADE riapre le sessioni",
    )
    expect(document.body.querySelector('[data-slot="section-title"]')).toBeNull()
  })

  test("i percorsi stanno in «Dettagli», chiuso, e restano nella pagina", async () => {
    hookStates = { "claude-code": state("claude-code", { installed: true }) }
    renderTab("agents/resume")
    await settle()

    const details = document.body.querySelector('[data-slot="hook-details"]')
    expect(details, "i Dettagli").not.toBeNull()
    expect(details?.tagName).toBe("DETAILS")
    expect((details as HTMLDetailsElement).open).toBe(false)
    expect(details?.querySelector("summary")?.textContent).toBe("Dettagli")
    expect(details?.querySelector('[data-slot="hook-paths"]')?.textContent).toContain("C:/u/claude-code.ps1")
  })

  test("se uno è da reinstallare la riga lo dice", async () => {
    hookStates = {
      "claude-code": state("claude-code", { installed: true }),
      codex: state("codex", { installed: true, outdated: true }),
    }
    renderTab("agents/resume")
    await settle()
    expect(document.body.querySelector("[data-hooks-summary]")?.textContent).toBe(
      "Ripresa attiva per 2 programmi su 3; uno chiede attenzione.",
    )
  })
})

describe("Agenti e account › Chiavi API", () => {
  test("la scheda è quella del portachiavi di oggi", () => {
    renderTab("agents/keys")
    expect(document.body.querySelector('[data-slot="settings-tab"][data-active="true"]')?.getAttribute("data-tab")).toBe(
      "agents/keys",
    )
    const source = readFileSync(join(import.meta.dir, "settings-sheet.tsx"), "utf-8")
    // S6: lo stesso portachiavi, più la domanda sulla chiave OpenRouter della voce; T5b: e la chiave xAI.
    expect(source).toMatch(/<KeysSection\s+host=\{props\.keysHost\(\)\}\s+agents=\{AGENTS\}/)
    expect(source).toContain("voiceConflict={props.voiceKeyConflict}")
  })
})

describe("i testi della categoria", () => {
  test("«Provider» e «Bot» sono nel catalogo, nelle due lingue", async () => {
    const { it } = await import("../i18n/it")
    const { en } = await import("../i18n/en")
    expect(it["settings.bots.title"]).toBe("Bot")
    expect(en["settings.bots.title"]).toBe("Bots")
    expect(it["settings.skills.none"]).toBe("Nessuno strumento")
    expect(en["settings.skills.none"]).toBe("No tools")
    expect(it["settings.providers.switchContinue"]).toBe("Continua")
    expect(en["settings.providers.switchContinue"]).toBe("Continue")
  })
})
