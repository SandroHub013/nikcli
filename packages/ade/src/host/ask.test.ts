import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { askDialog, askYesNo, remindQuestion, type AskDeps, type AskOptions, type NativeAskOptions } from "./ask"
import { t } from "../i18n"

/*
 * F-confirm (found live in B7): in ADE `confirm()` is the dialog plugin's
 * `confirm` command, not granted to the window. It returns a Promise, which
 * an `if` reads as yes, so the editor's questions were never asked.
 */

/** Lets the promises already resolved run their callbacks: the stop is not awaited. */
const settle = () => new Promise((resolve) => setImmediate(resolve))

function deps(over: Partial<AskDeps> = {}): AskDeps & { asked: [string, AskOptions][] } {
  const asked: [string, AskOptions][] = []
  return {
    asked,
    inTauri: () => true,
    load: async () => ({
      ask: async (message, options) => {
        asked.push([message, options])
        return true
      },
    }),
    browserConfirm: () => {
      throw new Error("non nel browser")
    },
    attention: async () => {},
    // The plugin's path unless a test says Windows: those tests are about the plugin's options.
    nativeAvailable: () => false,
    nativeAsk: async () => {
      throw new Error("non su questo sistema")
    },
    isMinimized: async () => false,
    restore: async () => {},
    front: async () => {},
    ...over,
  }
}

/** Windows: the question is `ade_ask`, which records what it was given. */
function windows(over: Partial<AskDeps> = {}, answer: boolean | Error = true) {
  const native: [string, NativeAskOptions][] = []
  const base = deps({
    nativeAvailable: () => true,
    nativeAsk: async (message, options) => {
      native.push([message, options])
      if (answer instanceof Error) throw answer
      return answer
    },
    load: async () => {
      throw new Error("il plugin non serve su Windows")
    },
    ...over,
  })
  return Object.assign(base, { native })
}

describe("una domanda sì/no in ADE", () => {
  test("passa dal comando ask del plugin dialog, con il titolo ADE e le etichette date", async () => {
    const d = deps()
    expect(await askYesNo("Chiudo?", { ok: "Chiudi", cancel: "Annulla" }, d)).toBe(true)
    expect(d.asked).toEqual([["Chiudo?", { title: "ADE", kind: "warning", okLabel: "Chiudi", cancelLabel: "Annulla" }]])
  })

  test("il no resta no", async () => {
    expect(await askYesNo("Chiudo?", {}, deps({ load: async () => ({ ask: async () => false }) }))).toBe(false)
  })

  test("una domanda che non si apre è un no, non un sì", async () => {
    const refused = deps({ load: async () => ({ ask: () => Promise.reject("dialog.ask not allowed") }) })
    expect(await askYesNo("Sovrascrivo?", {}, refused)).toBe(false)
    const missing = deps({ load: () => Promise.reject(new Error("no plugin")) })
    expect(await askYesNo("Sovrascrivo?", {}, missing)).toBe(false)
  })

  test("fuori da ADE (la pagina servita da vite) usa la domanda del browser", async () => {
    const seen: string[] = []
    const browser = deps({
      inTauri: () => false,
      browserConfirm: (message) => {
        seen.push(message)
        return false
      },
    })
    expect(await askYesNo("Chiudo?", {}, browser)).toBe(false)
    expect(seen).toEqual(["Chiudo?"])
  })

  test("askDialog lascia passare il rifiuto, per chi ne dice il motivo (i bot)", async () => {
    const refused = deps({ load: async () => ({ ask: () => Promise.reject("dialog.ask not allowed") }) })
    await expect(askDialog("Lo usi?", {}, refused)).rejects.toBe("dialog.ask not allowed")
  })

  test("la sezione Bot chiede con askDialog, con Sì e No, e la finestra ha ask e non confirm (B7)", () => {
    const capabilities = readFileSync(join(import.meta.dir, "../../src-tauri/capabilities/default.json"), "utf8")
    expect(capabilities).toContain('"dialog:allow-ask"')
    expect(capabilities).not.toContain('"dialog:allow-confirm"')
    const bots = readFileSync(join(import.meta.dir, "../bots/bots.tsx"), "utf8")
    expect(bots).not.toMatch(/(?<![\w$])(?:window\.)?confirm\s*\(/)
    expect(bots).toContain('askDialog(question, { ok: t("bots.ask.yes"), cancel: t("bots.ask.no") })')
  })

  /* chat-bot-facili, prove: the trust dialog opened over ADE, behind the app in front, unseen. */
  test("prima di chiedere la finestra chiama l'attenzione, e smette alla risposta", async () => {
    const steps: string[] = []
    const d = deps({
      attention: async (on) => void steps.push(on ? "attenzione" : "basta"),
      load: async () => ({ ask: async () => (steps.push("domanda"), true) }),
    })
    expect(await askDialog("Lo usi?", {}, d)).toBe(true)
    await settle()
    expect(steps).toEqual(["attenzione", "domanda", "basta"])
  })

  /* Review of chat-difetti, BASSO 1: the question waited on the window's call. */
  test("un'attenzione che non torna mai non tiene chiusa la domanda", async () => {
    const steps: string[] = []
    const d = deps({
      attention: (on) => (steps.push(on ? "attenzione" : "basta"), new Promise<void>(() => {})),
      load: async () => ({ ask: async () => (steps.push("domanda"), false) }),
    })
    expect(await askDialog("Lo usi?", {}, d)).toBe(false)
    await settle()
    // Never started, so nothing to stop.
    expect(steps).toEqual(["attenzione", "domanda"])
  })

  test("un'attenzione arrivata dopo la risposta si spegne lo stesso, dopo", async () => {
    const steps: string[] = []
    let started!: () => void
    const d = deps({
      attention: (on) => {
        steps.push(on ? "attenzione" : "basta")
        return on
          ? new Promise<void>((resolve) => (started = () => (steps.push("accesa"), resolve())))
          : Promise.resolve()
      },
      load: async () => ({ ask: async () => (steps.push("domanda"), true) }),
    })
    expect(await askDialog("Lo usi?", {}, d)).toBe(true)
    await settle()
    expect(steps).toEqual(["attenzione", "domanda"])
    started()
    await settle()
    expect(steps).toEqual(["attenzione", "domanda", "accesa", "basta"])
  })

  test("un'attenzione rifiutata non ferma la domanda, e un rifiuto della domanda la spegne lo stesso", async () => {
    const steps: string[] = []
    const refusedEye = deps({
      attention: async (on) => {
        steps.push(on ? "attenzione" : "basta")
        throw new Error("not allowed")
      },
    })
    expect(await askDialog("Lo usi?", {}, refusedEye)).toBe(true)
    await settle()
    const refusedAsk = deps({
      attention: async (on) => void steps.push(on ? "attenzione" : "basta"),
      load: async () => ({ ask: () => Promise.reject("dialog.ask not allowed") }),
    })
    await expect(askDialog("Lo usi?", {}, refusedAsk)).rejects.toBe("dialog.ask not allowed")
    await settle()
    expect(steps).toEqual(["attenzione", "basta", "attenzione", "basta"])
  })

  test("lint: the flash only when the window is not focused; the window is never focused, the question is brought forward", () => {
    const capabilities = JSON.parse(
      readFileSync(join(import.meta.dir, "../../src-tauri/capabilities/default.json"), "utf8"),
    )
    expect(capabilities.permissions).toContain("core:window:allow-request-user-attention")
    // The window call the restore makes must be granted, or it is silently refused.
    expect(capabilities.permissions).toContain("core:window:allow-unminimize")
    const source = readFileSync(join(import.meta.dir, "ask.ts"), "utf8")
    expect(source).toContain("if (!(await win.isFocused())) await win.requestUserAttention(UserAttentionType.Critical)")
    // The window is disabled while the question stands: focusing it left the foreground on a window that ignores keys.
    expect(source).not.toContain("setFocus")
    expect(source).toContain('invoke("ade_ask_front")')
    expect(source).toContain("if (minimized) await deps.restore()")
    const rust = readFileSync(join(import.meta.dir, "../../src-tauri/src/ask.rs"), "utf8")
    // The question is known by the window the dialog reports when it is created, not guessed among the popups the window owns.
    expect(rust).toContain("TDN_CREATED")
    expect(rust).toContain("question_of")
    expect(rust).not.toContain("GW_ENABLEDPOPUP")
    expect(readFileSync(join(import.meta.dir, "../../src-tauri/src/lib.rs"), "utf8")).toContain("ask::ade_ask_front,")
  })

  test("lint: every close question of the workbench goes through askYesNo, and a second ✕ is reminded", () => {
    const source = readFileSync(join(import.meta.dir, "../surface/workbench.tsx"), "utf8")
    const block = source.slice(source.indexOf("const closer = createCloser({"), source.indexOf("const close = (id: string)"))
    for (const field of ["ask:", "askRunning:", "askWorktree:"]) {
      expect(block).toMatch(new RegExp(`${field}[^\\n]*askYesNo\\(`))
    }
    expect(block).toContain("remind: () => void remindQuestion()")
    expect(block).not.toMatch(/(?<![\w$])(?:window\.)?confirm\s*\(/)
    // None of them reaches the plugin's `ask` (a «Yes» default) around askYesNo.
    expect(block).not.toMatch(/plugin-dialog|(?<![\w$])ask\(\s*t\(/)
  })

  test("lint: no confirm() left in the workbench: every question goes through askYesNo", () => {
    const source = readFileSync(join(import.meta.dir, "../surface/workbench.tsx"), "utf8")
    const calls = source
      .split("\n")
      .filter((line) => /(?<![\w$])(?:window\.)?confirm\s*\(/.test(line) && !/^\s*(?:\/\/|\*)/.test(line))
    expect(calls).toEqual([])
    expect(source).toContain("askYesNo")
  })
})

/*
 * The plugin's dialog has «Yes» as the default button, so a stray key or click on a question
 * hidden behind a minimised ADE answered «close anyway?» with a yes nobody gave. On Windows the
 * question is `ade_ask` (src-tauri/src/ask.rs): «No» is the default, and only «Yes» is a yes.
 */
describe("su Windows la domanda è ade_ask, con No predefinito", () => {
  test("chiede a ade_ask con Sì e No di default, e non passa dal plugin", async () => {
    const d = windows()
    expect(await askYesNo("Chiudo?", {}, d)).toBe(true)
    expect(d.native).toEqual([["Chiudo?", { title: "ADE", yes: t("ask.yes"), no: t("ask.no") }]])
    expect(d.asked).toEqual([])
  })

  test("le etichette di chi chiede sostituiscono quelle di default", async () => {
    const d = windows()
    await askYesNo("Chiudo?", { ok: "Chiudi", cancel: "Annulla" }, d)
    expect(d.native[0]![1]).toEqual({ title: "ADE", yes: "Chiudi", no: "Annulla" })
  })

  test("le etichette di default sono Sì e No, in italiano come in inglese il No resta No", () => {
    expect(t("ask.yes")).not.toBe("ask.yes")
    expect(t("ask.no")).not.toBe("ask.no")
  })

  test("è sì solo se ade_ask risponde true", async () => {
    expect(await askYesNo("Chiudo?", {}, windows({}, true))).toBe(true)
    expect(await askYesNo("Chiudo?", {}, windows({}, false))).toBe(false)
    // Anything but a true: a value the page cannot trust is a no.
    const odd = windows({ nativeAsk: async () => "true" as never })
    expect(await askYesNo("Chiudo?", {}, odd)).toBe(false)
  })

  test("un rifiuto di ade_ask è un no per askYesNo e passa da askDialog, per i bot", async () => {
    const failure = new Error("ade_ask failed")
    expect(await askYesNo("Chiudo?", {}, windows({}, failure))).toBe(false)
    await expect(askDialog("Lo usi?", {}, windows({}, failure))).rejects.toBe(failure)
  })

  test("la finestra ridotta a icona torna indietro prima della domanda", async () => {
    const steps: string[] = []
    const d = windows({
      isMinimized: async () => true,
      restore: async () => void steps.push("ripristino"),
      nativeAsk: async () => (steps.push("domanda"), false),
    })
    await askYesNo("Chiudo?", {}, d)
    expect(steps).toEqual(["ripristino", "domanda"])
  })

  test("con la finestra normale non si ripristina niente", async () => {
    const steps: string[] = []
    const d = windows({
      isMinimized: async () => false,
      restore: async () => void steps.push("ripristino"),
    })
    await askYesNo("Chiudo?", {}, d)
    expect(steps).toEqual([])
    expect(d.native.length).toBe(1)
  })

  test("un ripristino o una verifica che falliscono non impediscono la domanda", async () => {
    const refused = windows({
      isMinimized: async () => true,
      restore: () => Promise.reject(new Error("not allowed")),
    })
    expect(await askYesNo("Chiudo?", {}, refused)).toBe(true)
    const unknown = windows({ isMinimized: () => Promise.reject(new Error("no window")) })
    expect(await askYesNo("Chiudo?", {}, unknown)).toBe(true)
  })

  test("un ripristino che non torna mai non tiene chiusa la domanda", async () => {
    const d = windows({ isMinimized: async () => true, restore: () => new Promise<void>(() => {}) })
    expect(await askYesNo("Chiudo?", {}, d)).toBe(true)
  })

  test("fuori da Windows resta il plugin, con le etichette date e senza ade_ask", async () => {
    const d = deps({
      isMinimized: async () => {
        throw new Error("non serve")
      },
    })
    expect(await askYesNo("Chiudo?", { ok: "Chiudi", cancel: "Annulla" }, d)).toBe(true)
    expect(d.asked).toEqual([["Chiudo?", { title: "ADE", kind: "warning", okLabel: "Chiudi", cancelLabel: "Annulla" }]])
  })

  test("l'attenzione parte prima della domanda e si spegne dopo, anche su Windows", async () => {
    const steps: string[] = []
    const d = windows({
      attention: async (on) => void steps.push(on ? "attenzione" : "basta"),
      nativeAsk: async () => (steps.push("domanda"), true),
    })
    await askDialog("Lo usi?", {}, d)
    await settle()
    expect(steps).toEqual(["attenzione", "domanda", "basta"])
  })
})

/*
 * Prova dal vivo: dopo la seconda ✕ il primo piano era la finestra madre, disabilitata perché la domanda è modale,
 * e non il dialogo. Un tasto non lo raggiungeva: serviva un clic. Il fuoco va alla domanda, non alla finestra.
 */
describe("la domanda aperta prende il fuoco, non la finestra madre", () => {
  test("dopo il ripristino dall'icona, la domanda viene portata davanti, prima dell'attenzione", async () => {
    const steps: string[] = []
    const d = windows({
      isMinimized: async () => true,
      restore: async () => void steps.push("ripristino"),
      front: async () => void steps.push("domanda davanti"),
      attention: async (on) => void steps.push(on ? "attenzione" : "basta"),
    })
    await remindQuestion(d)
    expect(steps).toEqual(["ripristino", "domanda davanti", "attenzione"])
  })

  test("anche con la finestra normale ma dietro, la domanda viene portata davanti", async () => {
    const steps: string[] = []
    const d = windows({
      front: async () => void steps.push("domanda davanti"),
      restore: async () => void steps.push("ripristino"),
    })
    await remindQuestion(d)
    expect(steps).toEqual(["domanda davanti"])
  })

  test("fuori da Windows non c'è una domanda nativa da portare davanti", async () => {
    const steps: string[] = []
    const d = deps({
      isMinimized: async () => true,
      restore: async () => void steps.push("ripristino"),
      front: async () => void steps.push("domanda davanti"),
    })
    await remindQuestion(d)
    expect(steps).toEqual(["ripristino"])
  })

  test("un guasto o un ritardo infinito di front non fanno fallire il richiamo", async () => {
    await remindQuestion(windows({ front: () => Promise.reject(new Error("no question")) }))
    const started = Date.now()
    await remindQuestion(windows({ front: () => new Promise<void>(() => {}) }))
    expect(Date.now() - started).toBeLessThan(5000)
  })

  test("una domanda nuova non chiama front: si apre da sola in primo piano", async () => {
    const steps: string[] = []
    const d = windows({
      isMinimized: async () => true,
      restore: async () => void steps.push("ripristino"),
      front: async () => void steps.push("domanda davanti"),
      nativeAsk: async () => (steps.push("domanda"), false),
    })
    await askYesNo("Chiudo?", {}, d)
    expect(steps).toEqual(["ripristino", "domanda"])
  })
})

describe("remindQuestion: la seconda ✕ mostra la domanda aperta", () => {
  test("ripristina la finestra ridotta a icona e chiama l'attenzione, senza chiedere di nuovo", async () => {
    const steps: string[] = []
    const d = windows({
      isMinimized: async () => true,
      restore: async () => void steps.push("ripristino"),
      attention: async (on) => void steps.push(on ? "attenzione" : "basta"),
    })
    await remindQuestion(d)
    expect(steps).toEqual(["ripristino", "attenzione"])
    expect(d.native).toEqual([])
    expect(d.asked).toEqual([])
  })

  test("con la finestra normale chiama solo l'attenzione", async () => {
    const steps: string[] = []
    const d = windows({
      restore: async () => void steps.push("ripristino"),
      attention: async (on) => void steps.push(on ? "attenzione" : "basta"),
    })
    await remindQuestion(d)
    expect(steps).toEqual(["attenzione"])
  })

  test("fuori da ADE non fa niente", async () => {
    const steps: string[] = []
    const d = deps({
      inTauri: () => false,
      isMinimized: async () => (steps.push("verifica"), true),
      attention: async () => void steps.push("attenzione"),
    })
    await remindQuestion(d)
    expect(steps).toEqual([])
  })

  test("un guasto delle chiamate alla finestra non esce come errore", async () => {
    const d = deps({
      isMinimized: () => Promise.reject(new Error("no window")),
      attention: () => Promise.reject(new Error("not allowed")),
    })
    await remindQuestion(d)
  })
})
