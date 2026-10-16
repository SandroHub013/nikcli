import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { en } from "../i18n/en"
import { it } from "../i18n/it"

/*
 * Scelta 6: the words of every day, the technical word in brackets the first time, the same in Italian and in
 * English (D14, D15, D19, D20, D13, D23, D34, D35, D4).
 */
type Key = keyof typeof it
const text = (catalog: Record<string, unknown>, key: string, ...args: string[]) => {
  const entry = catalog[key]
  if (typeof entry === "function") return String((entry as (...a: string[]) => string)(...args))
  return String(entry)
}
const say = (key: string, ...args: string[]) => ({ it: text(it, key, ...args), en: text(en, key, ...args) })

const ours = (Object.keys(it) as Key[]).filter((key) => /^(bots|gateway)\./.test(key))

describe("the words of the bot's screens (scelta 6)", () => {
  test("the five terms, in words, with the technical one in brackets", () => {
    expect(say("bots.engine.label")).toEqual({ it: "Programma (runner)", en: "Program (runner)" })
    expect(say("bots.engine.effortField")).toEqual({ it: "Ragionamento (effort)", en: "Reasoning (effort)" })
    expect(say("bots.form.persona")).toEqual({ it: "Istruzioni (persona)", en: "Instructions (persona)" })
    expect(say("gateway.panel.heading")).toEqual({ it: "App di messaggi (gateway)", en: "Messaging apps (gateway)" })
    expect(say("gateway.panel.token")).toEqual({ it: "Codice del bot (token)", en: "Bot code (token)" })
  })

  test("one word for the face, the same in both languages", () => {
    expect(say("bots.form.logo")).toEqual({ it: "Faccia", en: "Face" })
    for (const key of ours) {
      expect(text(it, key, "a", "b", "c"), key).not.toMatch(/\b(logo|avatar)\b/i)
      expect(text(en, key, "a", "b", "c"), key).not.toMatch(/\b(logo|avatar)\b/i)
    }
  })

  test("«Motore», «Sforzo» and «Gateway ·» are gone from the bot's screens", () => {
    for (const key of ours) {
      const italian = text(it, key, "a", "b", "c")
      expect(italian, key).not.toMatch(/\bmotore\b|\bsforzo\b|Gateway ·/i)
      expect(text(en, key, "a", "b", "c"), key).not.toMatch(/Gateway ·|reasoning effort/i)
    }
  })

  test("the technical word is in brackets once, in the label, not repeated where it is read next", () => {
    expect(say("bots.engine.effort")).toEqual({ it: "Ragionamento", en: "Reasoning" })
    expect(say("bots.engine.effortStaleHint", "x").it).toContain("ragionamento")
    expect(say("bots.serve.effortNoModel", "x").it).not.toMatch(/sforzo/i)
    expect(say("bots.serve.effortDropped", "x", "m", "").it).toContain("livelli di ragionamento")
    expect(say("bots.serve.effortDropped", "x", "m", "").en).toContain("reasoning levels")
  })

  test("«token» is the bot's code in the texts that tell the user to paste it, and stays the word for the model's tokens", () => {
    for (const key of ["gateway.panel.tokenSaved", "gateway.panel.tokenReplace", "gateway.panel.clearToken", "gateway.panel.needToken"]) {
      expect(text(it, key), key).not.toMatch(/token/i)
      expect(text(en, key), key).not.toMatch(/token/i)
    }
    expect(say("bots.tokens", "12").it).toContain("token")
  })
})

describe("no sentence is put together from pieces (D19)", () => {
  test("the pieces are gone: one key per sentence, with its values", () => {
    for (const key of [
      "bots.subagent.isA",
      "bots.subagent.label",
      "bots.subagent.desc",
      "bots.settings.whenToUseHint1",
      "bots.settings.whenToUseHint2",
      "bots.permission.wantsToUse",
      "bots.permission.on",
      "bots.login.using",
    ]) {
      expect(key in it, key).toBe(false)
      expect(key in en, key).toBe(false)
    }
    expect(say("bots.permission.wantsOn", "bash", "rm -rf x")).toEqual({
      it: "Vuole usare «bash» su «rm -rf x»",
      en: "Wants to use «bash» on «rm -rf x»",
    })
    expect(say("bots.permission.roomWants", "Ale", "edit").it).toBe("@Ale vuole usare «edit»")
    expect(say("bots.login.usingMethod", "ChatGPT").en).toBe("Signed in with ChatGPT")
  })

  test("no text of the bot's screens begins or ends like the piece of a longer one", () => {
    for (const key of ours) {
      for (const catalog of [it, en] as Record<string, unknown>[]) {
        const value = text(catalog, key, "a", "b", "c")
        expect(value, key).not.toMatch(/(^[ ,;:.])|( $)/)
      }
    }
  })
})

describe("Italian and English say the same (D20)", () => {
  test("the same field has the same name when it is made and when it is changed", () => {
    expect(it["bots.settings.whenToUse"]).toBe(it["bots.form.description"])
    expect(en["bots.settings.whenToUse"]).toBe(en["bots.form.description"])
  })

  test("the account, the test and the empty roster no longer differ", () => {
    expect(say("bots.account.label")).toEqual({ it: "Account", en: "Account" })
    expect(text(it, "bots.roster.empty")).not.toMatch(/agente/i)
    expect(text(en, "bots.roster.empty")).not.toMatch(/agent/i)
    expect(text(en, "settings.bots.empty")).not.toMatch(/agent/i)
    expect(text(it, "settings.bots.empty")).not.toMatch(/agente/i)
    expect(say("gateway.approve.no")).toEqual({ it: "No", en: "No" })
  })

  test("the same count of brackets in both, in the labels that carry a technical term", () => {
    for (const key of ["bots.engine.label", "bots.engine.effortField", "bots.form.persona", "gateway.panel.heading", "gateway.panel.token"]) {
      expect(text(it, key).match(/\(/g)?.length, key).toBe(text(en, key).match(/\(/g)?.length)
    }
  })
})

describe("the individual points", () => {
  test("D13: the sentence on the intents says what to do and no longer contradicts itself", () => {
    const sentence = say("gateway.panel.intentsOff")
    expect(sentence.it).toContain("Lascia spenti")
    expect(sentence.it).not.toMatch(/resta chiuso|non si collega affatto/)
    expect(sentence.en).toContain("Leave")
    expect(sentence.en).not.toMatch(/stays closed|does not connect at all/)
  })

  test("D23: a room member waiting for the user says «aspetta te», as the Chat does", () => {
    expect(say("bots.room.needsYou").it).toBe(say("chat.session.waiting").it)
  })

  test("D35: the folder of a project's bots is not written as .ragu/agent", () => {
    for (const key of ["bots.form.scopeProject", "bots.trust.new"]) {
      expect(text(it, key, "x", "y"), key).not.toContain(".ragu/agent")
      expect(text(en, key, "x", "y"), key).not.toContain(".ragu/agent")
    }
  })

  test("D4: no reference to a place that is not there", () => {
    // The sign-ins are in Settings › Agents and accounts › Accounts: the names are the settings' own.
    const hint = say("bots.engine.accountHint")
    expect(hint.it).toContain(String(it["settings.category.agents"]))
    expect(hint.it).toContain(String(it["settings.tab.account"]))
    expect(hint.en).toContain(String(en["settings.category.agents"]))
    expect(hint.en).toContain(String(en["settings.tab.account"]))
    for (const key of ours) {
      expect(text(it, key, "a", "b", "c"), key).not.toMatch(/Impostazioni › Provider|scheda del bot/)
      expect(text(en, key, "a", "b", "c"), key).not.toMatch(/Settings › Providers|bot's card/)
    }
    expect(say("bots.runner.permissionDenied", "x").it).toContain("Terminale")
  })
})

/* D34: a key nothing reads is a text someone will translate and no one will see. */
describe("no key of the bot's screens is dead (D34)", () => {
  const SRC = join(import.meta.dir, "..")
  const sources: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) {
        if (name === "node_modules" || name === "i18n") continue
        walk(path)
      } else if (/\.(ts|tsx)$/.test(name) && !/\.test\./.test(name)) {
        sources.push(readFileSync(path, "utf8"))
      }
    }
  }
  walk(SRC)
  const code = sources.join("\n")

  /** Keys read through a template (`bots.memory.from.${origin}`): their stems. */
  const DYNAMIC = ["bots.routine.mode.", "bots.memory.from."]

  test("every bots.* and gateway.* text is read by something", () => {
    const dead = (Object.keys(it) as string[])
      .filter((key) => /^(bots|gateway)\./.test(key) || key.startsWith("settings.bots."))
      .filter((key) => !DYNAMIC.some((stem) => key.startsWith(stem)))
      .filter((key) => !code.includes(`"${key}"`) && !code.includes(`'${key}'`) && !code.includes(`\`${key}\``))
    expect(dead).toEqual([])
  })
})
