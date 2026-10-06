import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { convertGioco, giocoFiles, parseLivello, toGiocoJson, type Livello } from "./gioco-build"
import {
  GiocoTimer,
  PENALITA_ERRORE,
  PUNTI_INIEZIONE,
  PUNTI_PER_SECONDO,
  CATALOGO_GIOCO,
  chiaveGioco,
  emptyProgress,
  readLocale,
  recordGame,
  t,
  valutaLivello,
  voce,
} from "./page/learn.js"

/**
 * The levels of «Trova l'iniezione» are YAML written by hand and reviewed, and the page is served a converted JSON. As for the lessons
 * (`content.test.ts`), these tests hold the two together and take their rules from `gioco/schema.json` itself. The rest is the
 * grading, the progress and the timer, which are what a match is made of and have to give the same answer whenever they are asked.
 */

const ROOT = join(import.meta.dir, "gioco")
const files = giocoFiles(ROOT)
const levels = files.map((file) => parseLivello(readFileSync(join(ROOT, file), "utf8"), file))
const schema = JSON.parse(readFileSync(join(ROOT, "schema.json"), "utf8")) as Schema

type Schema = {
  $ref?: string
  type?: string
  const?: unknown
  enum?: unknown[]
  pattern?: string
  minLength?: number
  maxLength?: number
  minimum?: number
  maximum?: number
  minItems?: number
  maxItems?: number
  required?: string[]
  properties?: Record<string, Schema>
  additionalProperties?: boolean
  items?: Schema
  allOf?: { if: Schema; then: Schema }[]
  $defs?: Record<string, Schema>
}

/** The part of JSON Schema this schema uses, enough to check a level without adding a dependency to the package. */
function problems(rule: Schema, value: unknown, where = ""): string[] {
  if (rule.$ref) return problems(schema.$defs![rule.$ref.replace("#/$defs/", "")]!, value, where)
  const out: string[] = []
  if ("const" in rule && value !== rule.const) out.push(`${where}: must be ${JSON.stringify(rule.const)}`)
  if (rule.enum && !rule.enum.includes(value)) out.push(`${where}: ${JSON.stringify(value)} is not one of ${rule.enum.join(", ")}`)
  if (rule.type === "string") {
    if (typeof value !== "string") return [`${where}: not a string`]
    if (rule.pattern && !new RegExp(rule.pattern).test(value)) out.push(`${where}: does not match ${rule.pattern}`)
    if (rule.minLength !== undefined && value.length < rule.minLength) out.push(`${where}: shorter than ${rule.minLength}`)
    if (rule.maxLength !== undefined && value.length > rule.maxLength) out.push(`${where}: longer than ${rule.maxLength} (${value.length})`)
  }
  if (rule.type === "integer") {
    if (!Number.isInteger(value)) return [`${where}: not an integer`]
    if (rule.minimum !== undefined && (value as number) < rule.minimum) out.push(`${where}: below ${rule.minimum}`)
    if (rule.maximum !== undefined && (value as number) > rule.maximum) out.push(`${where}: above ${rule.maximum}`)
  }
  if (rule.type === "array") {
    if (!Array.isArray(value)) return [`${where}: not a list`]
    if (rule.minItems !== undefined && value.length < rule.minItems) out.push(`${where}: fewer than ${rule.minItems} items`)
    if (rule.maxItems !== undefined && value.length > rule.maxItems) out.push(`${where}: more than ${rule.maxItems} items`)
    value.forEach((item, n) => rule.items && out.push(...problems(rule.items, item, `${where}[${n}]`)))
  }
  if (rule.type === "object" || rule.properties || rule.required) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [`${where}: not an object`]
    const object = value as Record<string, unknown>
    for (const key of rule.required ?? []) if (!(key in object)) out.push(`${where}: lacks ${key}`)
    for (const [key, inner] of Object.entries(rule.properties ?? {})) if (key in object) out.push(...problems(inner, object[key], `${where}.${key}`))
    if (rule.additionalProperties === false) {
      for (const key of Object.keys(object)) if (!(key in (rule.properties ?? {}))) out.push(`${where}: ${key} is not allowed`)
    }
  }
  for (const branch of rule.allOf ?? []) if (problems(branch.if, value, where).length === 0) out.push(...problems(branch.then, value, where))
  return out
}

// ---- What the reviewer's checker (`ade-team/learn/gioco-iniezione/verifica.ts`) holds a level to, so the repo keeps it without that folder.

/** What each stage asks for: how many injections, how many decoys at least, whether an obvious one is allowed, how many lines at least. */
const TAPPE: Record<string, { min: number; max: number; esche: number; evidente: boolean; righe: number }> = {
  spiaggia: { min: 1, max: 1, esche: 0, evidente: true, righe: 5 },
  chiringuito: { min: 1, max: 2, esche: 1, evidente: false, righe: 6 },
  laguna: { min: 0, max: 2, esche: 1, evidente: false, righe: 8 },
  faro: { min: 2, max: 3, esche: 2, evidente: false, righe: 15 },
}
const ORDER = ["spiaggia", "chiringuito", "laguna", "faro"]
const FILE_EXT = new Set("md ts tsx js mjs json env yaml yml txt log tar gz zip png jpg svg conf sh py html css lock toml ini cfg bak sql csv pdf rs go crt pem".split(" "))
const FAKE_DOMAIN = /\.isola\.test$/i
const DOC_IP = /^(192\.0\.2|198\.51\.100|203\.0\.113)\.\d{1,3}$|^127\.0\.0\.1$/
const SECRET_LIKE: [RegExp, string][] = [
  [/\bsk-[A-Za-z0-9_-]{16,}/, "looks like a real API key"],
  [/\bghp_[A-Za-z0-9]{20,}/, "looks like a real GitHub token"],
  [/\bAKIA[0-9A-Z]{16}\b/, "looks like a real AWS key"],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/, "looks like a real Slack token"],
  [/-----BEGIN [A-Z ]*KEY-----/, "looks like a real private key"],
  [/[A-Za-z0-9+/]{40,}={0,2}/, "a long base64 string"],
]
const PAYLOAD: [RegExp, string][] = [
  [/\b(curl|wget)\b[^\n]*\|\s*(ba|z)?sh\b/i, "download-and-run command"],
  [/\brm\s+-[a-z]*r[a-z]*f?\s+\/(\s|$)/i, "deletion of the root"],
  [/\/dev\/tcp\//, "reverse connection"],
  [/\bnc\s+(-[a-z]*e|-c)\b/i, "netcat that executes"],
  [/-EncodedCommand|\bInvoke-Expression\b|\biex\s*\(/i, "PowerShell running encoded text"],
  [/\beval\s*\(\s*atob\b|\bbase64\s+(-d|--decode)\b/i, "decode and run"],
  [/\bpowershell(\.exe)?\b/i, "PowerShell command"],
]

/** Only invented names, no secret that looks real and no command that could be copied: a level is read by people and by models. */
function unsafe(text: string): string[] {
  const out: string[] = []
  for (const url of text.match(/https?:\/\/[^\s'")>\]]+/gi) ?? []) {
    const host = url.replace(/^https?:\/\//i, "").split(/[/:?#]/)[0] ?? ""
    if (!FAKE_DOMAIN.test(host)) out.push(`URL outside *.isola.test: ${url}`)
  }
  for (const mail of text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? []) if (!FAKE_DOMAIN.test(mail)) out.push(`email outside *.isola.test: ${mail}`)
  for (const name of text.match(/\b(?:[a-z0-9-]+\.)+[a-z][a-z0-9-]+\b/gi) ?? []) {
    const last = name.split(".").pop()!.toLowerCase()
    if (FAKE_DOMAIN.test(name) || FILE_EXT.has(last) || /^[a-z0-9-]+\.isola$/i.test(name) || /^(es|ecc|pag|n|vs|cfr)\./i.test(name)) continue
    out.push(`a name that looks like a real domain: ${name}`)
  }
  for (const ip of text.match(/\b\d{1,3}(\.\d{1,3}){3}\b/g) ?? []) if (!DOC_IP.test(ip)) out.push(`IP that is not for documentation: ${ip}`)
  for (const [re, why] of SECRET_LIKE) if (re.test(text)) out.push(why)
  for (const [re, why] of PAYLOAD) if (re.test(text)) out.push(`reusable payload: ${why}`)
  return out
}

describe("the levels", () => {
  test("gioco.json is the conversion of the YAML, letter for letter", () => {
    // The drift this catches: a level edited, reviewed or added without running `scripts/learn-content.ts`.
    expect(readFileSync(join(import.meta.dir, "gioco.json"), "utf8")).toBe(toGiocoJson(convertGioco(ROOT)))
  })

  test("there are 24, numbered from 1 with no gap, and no two have the same id", () => {
    expect(files).toHaveLength(24)
    const content = convertGioco(ROOT)
    expect(content.livelli.map((level) => level.livello)).toEqual(Array.from({ length: 24 }, (_, n) => n + 1))
    expect(new Set(content.livelli.map((level) => level.id)).size).toBe(24)
  })

  test("a draft never gets in", () => {
    expect(() => parseLivello("id: a\nstato: bozza\n", "bozza.yaml")).toThrow(/rivisto/)
  })

  for (const [n, level] of levels.entries()) {
    test(`${files[n]} follows the schema and the rules of its stage`, () => {
      expect(problems(schema, level)).toEqual([])
      const out: string[] = []
      if (files[n]!.replace(/\.yaml$/, "") !== level.id) out.push("the file name is not the id")
      if (Number(level.id.slice(4, 6)) !== level.livello) out.push("the number in the id is not the level")
      const rule = TAPPE[level.tappa]!
      const injections = level.righe.filter((riga) => riga.tipo === "iniezione")
      const decoys = level.righe.filter((riga) => riga.tipo === "esca")
      if (injections.length < rule.min || injections.length > rule.max) out.push(`${injections.length} injections for ${level.tappa}`)
      if (decoys.length < rule.esche) out.push(`${decoys.length} decoys for ${level.tappa}`)
      if (injections.length === 0 && decoys.length < 2) out.push("a clean level needs two decoys")
      if (!rule.evidente && injections.some((riga) => riga.travestimento === "evidente")) out.push("an obvious injection outside the beach")
      if (level.righe.length < rule.righe) out.push(`${level.righe.length} lines for ${level.tappa}`)
      if (level.secondi < 2 * level.righe.length) out.push(`${level.secondi} s for ${level.righe.length} lines`)
      if (new Set(level.righe.map((riga) => riga.testo)).size !== level.righe.length) out.push("two lines are the same")
      for (const text of [level.compito, level.spiegazione, ...level.righe.flatMap((riga) => [riga.testo, riga.perche ?? ""])]) out.push(...unsafe(text))
      // An injection is written as a sentence to a reader, never as shell.
      for (const riga of injections) {
        const bare = riga.testo.replace(/<!--|-->/g, "")
        for (const token of ["`", "$(", "|", "&&", ">", "<"]) if (bare.includes(token)) out.push(`an injection with «${token}»`)
      }
      expect(out).toEqual([])
    })
  }

  test("the series: two seasons of twelve, each going from the beach to the lighthouse, with a clean level in each lagoon", () => {
    for (const season of [levels.slice(0, 12), levels.slice(12)]) {
      const stages = season.map((level) => ORDER.indexOf(level.tappa))
      expect(stages).toEqual([...stages].sort((a, b) => a - b))
      expect(new Set(stages).size).toBe(4)
      const lagoon = season.filter((level) => level.tappa === "laguna")
      expect(lagoon.some((level) => level.righe.every((riga) => riga.tipo !== "iniezione"))).toBe(true)
    }
  })

  test("the injection is not always in the same place", () => {
    const places = levels.flatMap((level) => level.righe.flatMap((riga, n) => (riga.tipo === "iniezione" ? [n] : [])))
    const count = new Map<number, number>()
    for (const n of places) count.set(n, (count.get(n) ?? 0) + 1)
    // Many different places, and none that holds more than a third of them: a player cannot win by always clicking the same line.
    expect(count.size).toBeGreaterThanOrEqual(8)
    expect(Math.max(...count.values())).toBeLessThanOrEqual(Math.ceil(places.length / 3))
    // Nor in the same relative position (first, last, middle) level after level.
    const relative = levels
      .filter((level) => level.righe.some((riga) => riga.tipo === "iniezione"))
      .map((level) => {
        const first = level.righe.findIndex((riga) => riga.tipo === "iniezione")
        const where = first / (level.righe.length - 1)
        return where < 0.34 ? "start" : where > 0.66 ? "end" : "middle"
      })
    expect(new Set(relative).size).toBe(3)
  })

  test("every explanation names why, and every injection a defence the lesson teaches", () => {
    for (const level of levels) {
      for (const riga of level.righe) if (riga.tipo !== "normale") expect((riga.perche ?? "").length).toBeGreaterThan(19)
      expect(level.spiegazione.length).toBeGreaterThan(39)
    }
  })
})

/** A level built in the test, so a result does not depend on which of the 24 is first. */
const level = (...tipi: ("normale" | "esca" | "iniezione")[]) => ({
  righe: tipi.map((tipo, n) => ({ tipo, testo: `riga ${n}` })),
})

describe("valutaLivello", () => {
  const normali = ["normale", "esca", "iniezione", "normale", "iniezione"] as const
  const due = level(...normali)

  test("an injection found is worth 100, and a time bonus is added only to a level that was won", () => {
    const parziale = valutaLivello(due, [2], 20)
    expect(parziale).toMatchObject({ successo: false, trovate: [2], perse: [4], puntiIniezioni: PUNTI_INIEZIONE, tempoBonus: 0, punteggio: 100, stelle: 1 })
    const piena = valutaLivello(due, [2, 4], 20)
    expect(piena).toMatchObject({ successo: true, puntiIniezioni: 200, tempoBonus: 20 * PUNTI_PER_SECONDO, punteggio: 240, stelle: 3 })
  })

  test("each innocent line reported costs 50, a decoy as much as an ordinary line, and takes the third star", () => {
    const esito = valutaLivello(due, [2, 4, 1, 0], 0)
    expect(esito).toMatchObject({ falsePositive: [0, 1], escheSegnalate: [1], penalita: 2 * PENALITA_ERRORE, punteggio: 100, stelle: 2 })
  })

  test("the grade is never below zero, and a wrong report with nothing found has no star", () => {
    expect(valutaLivello(due, [0, 1, 3], 30)).toMatchObject({ punteggio: 0, stelle: 0, successo: false })
  })

  test("the same answer is graded the same way, whatever order it came in and however often it is asked", () => {
    const uno = valutaLivello(due, [4, 2, 2, 4], 12)
    const due2 = valutaLivello(due, new Set([2, 4]), 12)
    expect(uno).toEqual(due2)
    expect(valutaLivello(due, [2, 4], 12)).toEqual(uno)
  })

  test("a position that is not a line, or not a number, is nothing", () => {
    expect(valutaLivello(due, [2, 4, 99, -1, 1.5, "3" as unknown as number], 0)).toMatchObject({ falsePositive: [], stelle: 3 })
    expect(valutaLivello(due, undefined as unknown as number[], Number.NaN)).toMatchObject({ trovate: [], tempoBonus: 0, stelle: 0 })
  })

  test("a clean level is won by saying so, with nothing reported", () => {
    const pulito = level("normale", "esca", "normale", "esca", "normale")
    expect(valutaLivello(pulito, [], 10, true)).toMatchObject({ successo: true, isPulito: true, stelle: 3, punteggio: PUNTI_INIEZIONE + 10 * PUNTI_PER_SECONDO })
    // Reporting a decoy there loses it; so does letting the time run out without saying anything.
    expect(valutaLivello(pulito, [1], 10, false)).toMatchObject({ successo: false, stelle: 0, punteggio: 0, penalita: 50 })
    expect(valutaLivello(pulito, [], 0, false)).toMatchObject({ successo: false, stelle: 0, punteggio: 0 })
  })

  test("saying «none» on a level that has an injection finds none of them", () => {
    expect(valutaLivello(due, [2, 4], 30, true)).toMatchObject({ successo: false, trovate: [], perse: [2, 4], stelle: 0, punteggio: 0 })
  })
})

describe("recordGame", () => {
  const vinta = valutaLivello(level("normale", "iniezione", "normale", "normale", "esca"), [1], 10)

  test("keeps the stars and the points, counts the match, and marks the day", () => {
    const dopo = recordGame(emptyProgress(), "inj-01-prova", vinta, "2026-10-07")
    expect(dopo.esercizi[chiaveGioco("inj-01-prova")]).toEqual({ viste: 1, giuste: 1, intervallo: 0, stelle: 3, punti: 120 })
    expect(dopo.xp).toBe(120)
    expect(dopo.giorni).toEqual(["2026-10-07"])
  })

  test("does not touch what it was given", () => {
    const prima = emptyProgress()
    recordGame(prima, "inj-01-prova", vinta, "2026-10-07")
    expect(prima).toEqual(emptyProgress())
  })

  test("playing a level again keeps the best stars and earns only what beats the best score", () => {
    const una = recordGame(emptyProgress(), "inj-01-prova", vinta, "2026-10-07")
    const peggio = valutaLivello(level("normale", "iniezione", "normale", "normale", "esca"), [], 5)
    const due = recordGame(una, "inj-01-prova", peggio, "2026-10-08")
    expect(due.xp).toBe(120)
    expect(due.esercizi[chiaveGioco("inj-01-prova")]).toMatchObject({ viste: 2, giuste: 1, stelle: 3, punti: 120 })
    const meglio = valutaLivello(level("normale", "iniezione", "normale", "normale", "esca"), [1], 30)
    const tre = recordGame(due, "inj-01-prova", meglio, "2026-10-08")
    expect(tre.xp).toBe(160)
    expect(tre.giorni).toEqual(["2026-10-07", "2026-10-08"])
  })

  test("the key cannot be the key of a lesson's exercise", () => {
    expect(chiaveGioco("inj-01-prova")).toBe("gioco#inj-01-prova")
    expect(chiaveGioco("inj-01-prova")).not.toContain("/")
  })
})

/** A clock the test turns by hand. */
function clock() {
  let now = 1_000
  const intervals = new Map<number, () => void>()
  let next = 1
  return {
    orologio: {
      now: () => now,
      setInterval: (fn: () => void) => {
        intervals.set(next, fn)
        return next++
      },
      clearInterval: (id: number) => void intervals.delete(id),
    },
    running: () => intervals.size,
    advance(ms: number) {
      now += ms
      for (const fn of [...intervals.values()]) fn()
    },
  }
}

describe("GiocoTimer", () => {
  test("has no timer until it is started, and none once it has stopped", () => {
    const c = clock()
    const timer = new GiocoTimer(30, () => {}, () => {}, c.orologio)
    expect(c.running()).toBe(0)
    timer.avvia()
    timer.avvia()
    expect(c.running()).toBe(1)
    timer.ferma()
    expect(c.running()).toBe(0)
    timer.ferma()
    expect(c.running()).toBe(0)
  })

  test("counts down in whole seconds, from the clock and not from the ticks, and says when it ends once", () => {
    const c = clock()
    const ticks: number[] = []
    let scaduto = 0
    const timer = new GiocoTimer(3, (s: number) => void ticks.push(s), () => void scaduto++, c.orologio)
    timer.avvia()
    c.advance(250)
    expect(ticks).toEqual([])
    c.advance(1000)
    expect(ticks).toEqual([2])
    // A frame that slept for two seconds gives none of them back.
    c.advance(2000)
    expect(ticks.at(-1)).toBe(0)
    expect(scaduto).toBe(1)
    expect(c.running()).toBe(0)
    c.advance(5000)
    expect(scaduto).toBe(1)
  })

  test("stopped by hand, it never says the time is up", () => {
    const c = clock()
    let scaduto = 0
    const timer = new GiocoTimer(2, () => {}, () => void scaduto++, c.orologio)
    timer.avvia()
    c.advance(1000)
    timer.ferma()
    c.advance(10_000)
    expect(scaduto).toBe(0)
  })
})

describe("the game's words", () => {
  test("Italian and English have the same words, and the tables have the same entries", () => {
    const it = CATALOGO_GIOCO.it as Record<string, unknown>
    const en = CATALOGO_GIOCO.en as Record<string, unknown>
    expect(Object.keys(en).sort()).toEqual(Object.keys(it).sort())
    for (const key of Object.keys(it)) {
      if (typeof it[key] === "object") expect(Object.keys(en[key] as object).sort()).toEqual(Object.keys(it[key] as object).sort())
      else expect([key, (en[key] as string).match(/\{\d+\}/g)?.sort()]).toEqual([key, (it[key] as string).match(/\{\d+\}/g)?.sort()])
    }
  })

  test("every stage, defence, effect and disguise the levels use has a word in both languages", () => {
    for (const level of levels) {
      for (const lingua of ["it", "en"]) {
        const words = (CATALOGO_GIOCO as unknown as Record<string, Record<string, Record<string, string>>>)[lingua]!
        expect(words.tappa).toHaveProperty(level.tappa)
        for (const riga of level.righe) {
          if (riga.tipo !== "iniezione") continue
          expect(words.difese).toHaveProperty(riga.difesa!)
          expect(words.effetti).toHaveProperty(riga.effetto!)
          expect(words.travestimenti).toHaveProperty(riga.travestimento!)
        }
        expect(voce("tappa", level.tappa, lingua)).toBe(words.tappa![level.tappa]!)
      }
    }
  })

  test("a word is filled in, English is only asked for by the address, and a missing word shows as itself", () => {
    expect(t("livello", "it", 3, "Laguna")).toBe("Livello 3 · Laguna")
    expect(t("livello", "en", 3, "Lagoon")).toBe("Level 3 · Lagoon")
    expect(readLocale("#n=abc&l=en")).toBe("en")
    expect(readLocale("#n=abc&l=fr")).toBe("it")
    expect(readLocale("#n=abc")).toBe("it")
    expect(t("non-esiste", "en")).toBe("non-esiste")
  })
})

export type { Livello }
