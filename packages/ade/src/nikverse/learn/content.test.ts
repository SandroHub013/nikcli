import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { convert, lessonFiles, parseLesson, toJson } from "./content-build"

/**
 * The lessons are the one thing here that is not code: they come from a folder of YAML written by hand and reviewed, and the page is
 * served a converted JSON. These tests are what holds the two together, and they take their rules from `schema.json` itself, so the
 * copy in the repo and the copy of `ade-team/learn/` cannot drift apart without this file noticing.
 */

const ROOT = import.meta.dir
const lessons = (file: string) => readFileSync(join(ROOT, "lezioni", file), "utf8")
const schema = JSON.parse(readFileSync(join(ROOT, "schema.json"), "utf8")) as Schema
const committed = readFileSync(join(ROOT, "content.json"), "utf8")

interface Schema {
  $id?: string
  required: string[]
  properties: Record<string, { type?: string; enum?: unknown[]; pattern?: string; items?: { properties?: Record<string, { pattern?: string }> } }>
  $defs: Record<string, Schema>
}

/** A lesson read from its own file, so a failure names the file and not an index. */
const fromFile = (file: string) => parseLesson(lessons(file), file)

const files = lessonFiles(join(ROOT, "lezioni"))

describe("content.json", () => {
  test("is the conversion of the YAML, letter for letter", () => {
    // The drift this catches: a lesson edited, reviewed or added without running `scripts/learn-content.ts`.
    expect(committed).toBe(toJson(convert(join(ROOT, "lezioni"))))
  })

  test("carries the five lessons of the first path, in order", () => {
    const content = convert(join(ROOT, "lezioni"))
    expect(content.v).toBe(1)
    expect(content.percorsi.map((percorso) => percorso.tema)).toEqual(["agenti-llm"])
    expect(content.percorsi[0].titolo).toBe("Agenti e LLM")
    expect(content.percorsi[0].lezioni.map((lesson) => lesson.id)).toEqual([
      "agenti-llm/01-token-contesto",
      "agenti-llm/02-ruoli-prompt",
      "agenti-llm/03-ciclo-agente",
      "agenti-llm/04-iniezione-dati",
      "agenti-llm/05-sandbox-allowlist-budget",
    ])
  })

  test("every file in the folder is a lesson, and no two say the same thing", () => {
    expect(files.length).toBe(5)
    const ids: string[] = []
    for (const file of files) ids.push(String(fromFile(file).id))
    expect(new Set(ids).size).toBe(ids.length)
    // The id is the theme and the file name without the extension: that is how a lesson is asked for.
    for (const file of files) {
      const [, theme, name] = /^([^/]+)\/([^/]+)$/.exec(file) ?? []
      expect(String(fromFile(file).id)).toBe(`${theme}/${String(name).replace(/\.yaml$/, "")}`)
    }
  })

  test("every exercise has a unique progress key across all lessons and percorsi", () => {
    const content = convert(join(ROOT, "lezioni"))
    const keys: string[] = []
    for (const percorso of content.percorsi) {
      for (const lezione of percorso.lezioni) {
        for (const esercizio of (lezione.esercizi as { id: string }[])) {
          keys.push(`${String(lezione.id)}#${esercizio.id}`)
        }
      }
    }
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe("a lesson is refused before it is ever served", () => {
  const good = "id: agenti-llm/01-x\ntema: agenti-llm\nstato: rivista\n"

  test("a draft is not converted, and says why", () => {
    expect(() => parseLesson(good.replace("rivista", "bozza"), "bozza.yaml")).toThrow(/rivista/)
  })

  test("YAML that does not parse, and a document that is not a lesson", () => {
    expect(() => parseLesson("a:\n  - b\n c", "rotta.yaml")).toThrow(/YAML non valido/)
    expect(() => parseLesson("- 1\n- 2", "lista.yaml")).toThrow(/documento/)
  })
})

describe("every lesson, against the schema", () => {
  for (const file of files) {
    const lesson = fromFile(file)

    test(`${file}: the fields the schema requires, and nothing beside them`, () => {
      // `additionalProperties: false` is the schema's way of saying a field nobody reads must not be there: it would look like a rule
      // that is being applied and would not be. `prerequisiti` is one of the schema's own fields, only not required.
      expect(Object.keys(lesson).filter((key) => !(key in schema.properties))).toEqual([])
      for (const field of schema.required) {
        const value = lesson[field]
        const type = schema.properties[field]?.type
        expect(value, `${file}: ${field} manca`).toBeDefined()
        if (type === "string" || type === "integer") expect(typeof value).toBe(type === "integer" ? "number" : "string")
        if (type === "array" || type === "object") expect(Array.isArray(value)).toBe(type === "array")
      }
      expect(schema.properties.tema.enum).toContain(lesson.tema)
      expect(String(lesson.lingua)).toBe("it")
    })

    test(`${file}: the objectives, and every exercise serves one that exists`, () => {
      const obiettivi = lesson.obiettivi as { id: string; testo: string }[]
      const pattern = new RegExp(schema.properties.obiettivi.items!.properties!.id.pattern!)
      expect(obiettivi.length).toBeGreaterThanOrEqual(3)
      for (const obiettivo of obiettivi) {
        expect(obiettivo.id).toMatch(pattern)
        expect(obiettivo.testo.length).toBeGreaterThanOrEqual(10)
      }
      const declared = obiettivi.map((obiettivo) => obiettivo.id)
      for (const esercizio of lesson.esercizi as { obiettivo: string }[]) expect(declared).toContain(esercizio.obiettivo)
      for (const card of lesson.teoria as { obiettivi: string[]; fonti?: string[] }[]) {
        for (const id of card.obiettivi) expect(declared).toContain(id)
      }
      const fonti = (lesson.fonti as { id: string }[]).map((fonte) => fonte.id)
      expect(fonti.length).toBeGreaterThanOrEqual(1)
      for (const card of lesson.teoria as { fonti?: string[] }[]) {
        for (const id of card.fonti ?? []) expect(fonti).toContain(id)
      }
    })

    test(`${file}: the exercises are of the five types, and each has what its type needs`, () => {
      const esercizi = lesson.esercizi as Record<string, unknown>[]
      const tipi = schema.$defs.esercizio.properties.tipo.enum as string[]
      // One lesson of 2-5 minutes: eight exercises at least, twelve at most, and nothing repeated.
      expect(esercizi.length).toBeGreaterThanOrEqual(8)
      expect(esercizi.length).toBeLessThanOrEqual(12)
      const ids = esercizi.map((esercizio) => String(esercizio.id))
      expect(new Set(ids).size).toBe(ids.length)
      for (const esercizio of esercizi) {
        const tipo = String(esercizio.tipo)
        expect(tipi, `${esercizio.id}: tipo ${tipo}`).toContain(tipo)
        for (const field of [...schema.$defs.comune.required, ...schema.$defs[tipo].required]) {
          expect(esercizio[field], `${esercizio.id}: ${tipo} senza ${field}`).toBeDefined()
        }
        // What a reader is told after answering: the right answer, and why each wrong one is wrong.
        const sbagliate = esercizio.sbagliate as { risposta: unknown; perche: string }[]
        expect(sbagliate.length).toBeGreaterThanOrEqual(2)
        for (const sbagliata of sbagliate) expect(sbagliata.perche.length).toBeGreaterThanOrEqual(20)
      }
      expect(lesson.stato).not.toBe("bozza")
    })

    test(`${file}: every objective has two exercises, and at least three kinds of exercise`, () => {
      const esercizi = lesson.esercizi as { obiettivo: string; tipo: string }[]
      for (const obiettivo of lesson.obiettivi as { id: string }[]) {
        const count = esercizi.filter((esercizio) => esercizio.obiettivo === obiettivo.id).length
        expect(count, `${obiettivo.id}: ${count} esercizi`).toBeGreaterThanOrEqual(2)
      }
      expect(new Set(esercizi.map((esercizio) => esercizio.tipo)).size).toBeGreaterThanOrEqual(3)
    })

    test(`${file}: the right answer is not always in the same place`, () => {
      // A learner who learns the position learns nothing: the position has to move inside the lesson.
      const positions = (lesson.esercizi as { tipo: string; giusta?: unknown }[])
        .filter((esercizio) => esercizio.tipo === "scelta")
        .map((esercizio) => Number(esercizio.giusta))
      expect(positions.length).toBeGreaterThanOrEqual(3)
      expect(new Set(positions).size, `tutte in posizione ${positions[0]}`).toBeGreaterThan(1)
      for (const esercizio of lesson.esercizi as { id: string; tipo: string; giusta?: unknown; sbagliate: { risposta: unknown }[] }[]) {
        if (esercizio.tipo === "scelta") {
          // And never inside the wrong answers, which are what the learner is shown instead.
          for (const sbagliata of esercizio.sbagliate) expect(sbagliata.risposta).not.toBe(esercizio.giusta)
        }
      }
    })
  }
})

describe("the schema in the repo is the one of the course", () => {
  test("it is the copy of ade-team/learn/schema.json, with its five exercise types", () => {
    expect(schema.$id).toBe("https://nikverse.isola.test/learn/lezione.schema.json")
    expect(schema.$defs.esercizio.properties.tipo.enum).toEqual(["scelta", "completa", "ordina", "trova-riga", "abbina"])
    expect(schema.required).toContain("esercizi")
    expect(schema.properties.id.pattern).toBe("^[a-z][a-z0-9-]{1,31}/[0-9]{2}-[a-z0-9-]{3,40}$")
  })

  test("every lesson uses every type somewhere in the path, so none of them is untested on a page", () => {
    const used = new Set<string>()
    for (const file of files) for (const esercizio of fromFile(file).esercizi as { tipo: string }[]) used.add(esercizio.tipo)
    expect([...used].sort()).toEqual(["abbina", "completa", "ordina", "scelta", "trova-riga"])
  })
})
