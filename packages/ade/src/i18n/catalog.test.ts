import { describe, expect, test } from "bun:test"
import { en } from "./en"
import { it } from "./it"

/*
 * `en: Messages` already makes tsc refuse a missing key or a different
 * parameter list. These repeat it at runtime, where it is cheap, and add the
 * two mistakes the type system cannot see: an empty English text, and one
 * that was pasted in Italian and never translated.
 */

/** Texts that are the same word in both languages, or are names. */
const SAME_IN_BOTH = new Set<string>([
  // The name of the app, in any language.
  "bots.waiting.fromAde",
  "design.shortTitle",
  // «Sessione 1 — Terminal (2)»: a title and a number, in any language.
  "choices.samePane",
  "settings.language.it",
  "settings.language.en",
  // The «No» button of a yes/no question: the same word in both.
  "ask.no",
  // The «No» of a permission prompt: the same word in both.
  "permission.answer.no",
  "preset.solo",
  // «Branch» is git's word, in both.
  "pane.tree.branch",
  "pane.quota",
  "settings.grid.auto",
  "gateway.panel.platformTelegram",
  "gateway.panel.platformDiscord",
  "gateway.panel.platformSlack",
  // «Telegram: On»: the platform's name and the state's word, in the same shape in both.
  "gateway.tile.aria",
  "bots.face.color.magenta",
  "gateway.panel.tokenPlaceholderSlack",
  "gateway.panel.tokenPlaceholder",
  "gateway.approve.no",
  "bots.account.label",
  "bots.account.option",
  "gateway.panel.appTokenPlaceholder",
  "record.consent.no",
  "bots.ask.no",
  "vui.hud.no",
  "pane.video.title",
  "vui.audio.title",
  "settings.tab.voiceDevices",
  "browser.owner.ready",
  "bots.card.file",
  "settings.providers.desc2After",
  "agent.empty.example1",
  "agent.empty.example2",
  "agent.empty.example3",
  "design.title",
  "newPane.design",
  "newPane.browser",
  "newPane.raguverse",
  "update.dialog.escKey",
  "vui.backend.piper",
  "vui.backend.kokoro",
  "vui.backend.mai",
  "vui.backend.mai2",
  "vui.mai.title",
  "vui.reply.mai.it-IT-Grant",
  "vui.reply.mai.it-IT-Harper",
  "vui.reply.mai.it-IT-Luca",
  "vui.reply.mai.it-IT-Rosa",
  "vui.reply.kokoro.af_heart",
  "vui.reply.kokoro.am_fenrir",
  "vui.reply.kokoro.bf_emma",
  "vui.reply.kokoro.bm_george",
  "vui.replies.sample.it",
  "vui.replies.sample.en",
  "bar.meta.ade",
  "bar.meta.ragu",
  "pane.tree.worktree",
])

type Key = keyof typeof it

function sample(entry: unknown): string {
  if (typeof entry !== "function") return String(entry)
  const args = Array.from({ length: entry.length }, (_, i) => `«${i}»`)
  return String(entry(...args))
}

describe("the catalogs", () => {
  test("the voice hint explains the pause in ei ragù and that the name alone is enough", () => {
    const italian = it["vui.wake.hint"]("ragù")
    expect(italian).toContain("Basta dire «ei ragù»")
    expect(italian).toContain("«ei ragù» staccato, con una pausa dopo il nome")
    const english = en["vui.wake.hint"]("ragù")
    expect(english).toContain("Just say “ragù”")
    expect(english).toContain("“ei ragù” as separate words, with a pause after the name")
    expect(english).toContain("for example “ragù, open the browser”")
    expect(english).not.toContain("apri il browser")
  })

  test("the English voice hint calls the configured name", () => {
    expect(en["vui.wake.hint"]("jarvis")).toStartWith("Just say “jarvis” to call it.")
  })

  test("the voice texts use the glossary: no «motore» in Italian, no engine in English (S7)", () => {
    const voiceKeys = (Object.keys(it) as Key[]).filter((key) => key.startsWith("vui."))
    expect(voiceKeys.length).toBeGreaterThan(100)
    expect(voiceKeys.filter((key) => /motor/i.test(sample(it[key])))).toEqual([])
    expect(voiceKeys.filter((key) => /\bengines?\b/i.test(sample(en[key])))).toEqual([])
    expect(it["vui.engine.title"]).toBe("Agente vocale")
    expect(it["vui.rail.engine"]).toBe("Riconoscimento")
    expect(it["vui.reply.title"]).toBe("Voce delle risposte")
    // The MAI box sits on Voce delle risposte: its title does not say it again.
    expect(it["vui.mai.title"]).toBe("Microsoft MAI")
    expect(it["vui.activation.toggle"]).not.toMatch(/click/i)
  })

  test("the commands are named for what they do (review S7, B1)", () => {
    expect(it["vui.intent.app.new"]).toBe("Apri il simulatore")
    expect(it["vui.intent.model.new"]).toBe("Apri il visore 3D")
    expect(it["vui.intent.project.recent"]).toBe("Apri un progetto recente")
    expect(it["vui.intent.dictation.finish"]).toBe("Finisci e invia la dettatura")
    expect(it["vui.intent.palette.open"]).toBe("Apri Cerca comandi")
    expect(en["vui.intent.app.new"]).toBe("Open the simulator")
    expect(en["vui.intent.dictation.finish"]).toBe("Finish and send the dictation")
  })

  test("every voice command has a name in both languages (S7)", async () => {
    const { VOCABULARY } = await import("@ragu/voice/core")
    for (const spec of VOCABULARY) {
      const key = `vui.intent.${spec.intent}` as Key
      expect(typeof it[key], key).toBe("string")
      expect(typeof en[key], key).toBe("string")
      expect(sample(it[key])).not.toBe(spec.intent)
    }
  })

  test("have the same keys", () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(it).sort())
  })

  test("take the same values in the same texts", () => {
    for (const key of Object.keys(it) as Key[]) {
      const source = it[key] as unknown
      const translated = en[key] as unknown
      expect(`${key}: ${typeof translated}`).toBe(`${key}: ${typeof source}`)
      if (typeof source === "function" && typeof translated === "function") {
        expect(`${key}: ${translated.length}`).toBe(`${key}: ${source.length}`)
      }
    }
  })

  test("have an English text for every key, and not the Italian one", () => {
    const empty: string[] = []
    const untranslated: string[] = []
    for (const key of Object.keys(it) as Key[]) {
      const english = sample(en[key])
      if (english.trim().length === 0) empty.push(key)
      if (english === sample(it[key]) && !SAME_IN_BOTH.has(key)) untranslated.push(key)
    }
    expect(empty).toEqual([])
    expect(untranslated).toEqual([])
  })

  test("every value a text takes shows up in it, in both languages", () => {
    const dropped: string[] = []
    for (const key of Object.keys(it) as Key[]) {
      for (const [name, entry] of [
        ["it", it[key]],
        ["en", en[key]],
      ] as const) {
        if (typeof entry !== "function") continue
        const text = sample(entry)
        for (let i = 0; i < entry.length; i++) if (!text.includes(`«${i}»`)) dropped.push(`${name} ${key} #${i}`)
      }
    }
    expect(dropped).toEqual([])
  })

  test("the voice texts quote with «» in Italian and “” in English, never straight quotes (S8)", () => {
    for (const catalog of [it, en]) {
      const straight = (Object.keys(catalog) as Key[]).filter(
        (key) => key.startsWith("vui.") && sample(catalog[key]).includes('"'),
      )
      expect(straight).toEqual([])
    }
  })

  test("the shortcuts page description ends its sentence (S8)", () => {
    expect(sample(it["vui.shortcuts.desc"])).toEndWith(".")
    expect(sample(en["vui.shortcuts.desc"])).toEndWith(".")
  })

  test("the exceptions still exist, so the list cannot rot", () => {
    for (const key of SAME_IN_BOTH) expect(Object.keys(it)).toContain(key)
  })
})

/** Every text of a catalog, functions called with marked arguments, with its key. */
function allTexts(catalog: Record<string, unknown>): [string, string][] {
  return Object.keys(catalog).map((key) => [key, sample(catalog[key])])
}

describe("the words of the glossary (UX-11, UX-12, UX-27)", () => {
  // «App di messaggi (gateway)» is the user's own choice (bots/words.test.ts, scelta 6): the technical word stays in brackets.
  const CHOSEN = new Set(["gateway.panel.heading"])
  const italian = allTexts(it).filter(([key]) => !CHOSEN.has(key))

  test("one term for each concept: the losing synonyms are gone from the Italian texts", () => {
    const forbidden: [string, RegExp][] = [
      ["a project is a progetto, not a Space", /\bSpaces?\b|(?:uno|lo|nello) space\b/],
      ["a worktree is a copia di lavoro (worktree git, once)", /\b[Ww]orktree\b(?! git\)|, worktree\b)/],
      ["the command palette is Cerca comandi", /\b[Pp]alette\b|tavolozza|Cerca o esegui/],
      ["check again is Ricontrolla", /Controlla di nuovo/],
      ["a screenshot tray is Schermate", /vassoio/],
      ["kill is termina", /[Uu]cciso|[Uu]ccidi/],
      ["a task is a compito", /\btasks?\b/],
      ["a gateway is a collegamento chat", /\b[Gg]ateway\b/],
      ["Decisioni is never cut to Dec", /^Dec$/],
      ["the input box is the casella dove si scrive: a compositore writes music or draws windows", /compositore(?! grafico)/i],
      ["a pane is a pannello", /riquadr/i],
    ]
    for (const [why, pattern] of forbidden) {
      expect(italian.filter(([, text]) => pattern.test(text)).map(([key]) => key), why).toEqual([])
    }
  })

  test("a worktree is a copia di lavoro, never an albero isolato (UX-11)", () => {
    expect(italian.filter(([, text]) => /[Aa]lbero isolato/.test(text)).map(([key]) => key)).toEqual([])
  })

  test("a notice is taken off, as the bar says: «Togli l'avviso», not «Scarta l'avviso» (UX-27)", () => {
    expect(italian.filter(([, text]) => /Scarta l'avviso/.test(text)).map(([key]) => key)).toEqual([])
  })

  test("the Account page says the agents are for sessions as well as bots, and a missing one says where to install it (UX-16)", () => {
    expect(it["settings.account.intro"]).toContain("sessioni")
    expect(en["settings.account.intro"]).toContain("sessions")
    expect(it["settings.providers.notInstalled.hint"]).toBe("Non installato: lo installi da Nuova sessione")
    expect(en["settings.providers.notInstalled.hint"]).toBe("Not installed: install it from New session")
    // The chip keeps its short word; the hint rides in the tooltip.
    expect(it["settings.providers.notInstalled"]).toBe("Non installato")
    expect(en["settings.providers.notInstalled"]).toBe("Not installed")
  })

  test("ADE's written texts are in the feminine: never «non sono riuscito» or «ADE non è riuscito»", () => {
    expect(italian.filter(([, text]) => /[Nn]on sono riuscito\b|ADE non è riuscito\b/.test(text)).map(([key]) => key)).toEqual([])
  })

  // The voice's own lines (voice.msg.*) say nothing about its gender: the default voice, Ugo, is a man's and Rosa's is a
  // woman's. «Non riesco a…», not «Non sono riuscita a…» (see packages/voice/src/neutral-self.test.ts).
  test("the voice's own lines carry no gender about itself", () => {
    const self = /\b(?:[Nn]on )?[Ss]ono (?:riuscit[oa]|svegli[oa]|pront[oa])\b|\bADE non è riuscit[oa]\b/
    expect(italian.filter(([key, text]) => key.startsWith("voice.msg.") && self.test(text)).map(([key]) => key)).toEqual([])
  })

  test("an ellipsis is the one character «…», never three dots, in the Italian texts", () => {
    expect(italian.filter(([, text]) => /[^.]\.\.\.(?!\.)/.test(text)).map(([key]) => key)).toEqual([])
  })

  test("the English UI never says «Dec» for decisions, which reads as December", () => {
    expect(en["decisions.shortTitle"]).toBe("Decisions")
  })
})

describe("the confirmation dialogs name their action (UX-10)", () => {
  const dialogs = ["pane.closeRunning", "pane.closeWorktree", "editor.closeDirty", "editor.saveUnreadable", "editor.saveChanged"] as const
  test("each one has its own two buttons, and neither is «Sì» or «No»", () => {
    for (const dialog of dialogs) {
      for (const catalog of [it, en] as Record<string, unknown>[]) {
        const ok = sample(catalog[`${dialog}.ok`])
        const cancel = sample(catalog[`${dialog}.cancel`])
        expect([ok, cancel], dialog).not.toContain(sample(catalog["ask.yes"]))
        expect([ok, cancel], dialog).not.toContain(sample(catalog["ask.no"]))
        expect(ok, dialog).not.toBe(cancel)
      }
    }
  })

  test("the questions are the report's, and «comunque» is the one word for «anyway»", () => {
    expect(it["pane.closeRunning"]("Sessione 1")).toBe("Chiudere «Sessione 1»? L'agente è ancora al lavoro e si ferma.")
    expect(it["pane.closeRunning.ok"]).toBe("Chiudi e ferma")
    expect(it["pane.closeRunning.cancel"]).toBe("Lascia aperta")
    expect(it["editor.closeDirty"]("a.ts")).toBe("Chiudere a.ts senza salvare? Le modifiche non salvate vanno perse.")
    expect(it["editor.closeDirty.ok"]).toBe("Chiudi senza salvare")
    expect(it["editor.closeDirty.cancel"]).toBe("Torna al file")
    expect(it["editor.saveChanged"]("a.ts")).toBe("a.ts è cambiato su disco dopo che l'hai aperto. Salvando, le tue modifiche sostituiscono quella versione.")
    expect(it["editor.saveChanged.ok"]).toBe("Sostituisci")
    expect(it["window.closeConfirm.message"](2)).toEndWith("Chiudere comunque?")
    expect(it["window.closeConfirm.message"](2)).not.toContain("lo stesso")
  })
})
