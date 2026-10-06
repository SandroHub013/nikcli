/**
 * The lessons of «Impara», read from their YAML and turned into the one `content.json` the page is served.
 *
 * A lesson is a YAML file under `lezioni/<theme>/`, written by whoever drafts it and reviewed before it goes in (`schema.json`
 * next to this file, the contracts of `ade-team/learn/`). The page is plain JavaScript with no build, so it cannot read YAML: what it
 * is served is this file, and `content.test.ts` re-runs the conversion and fails if the committed JSON is not the same thing. That is
 * what keeps a lesson edited after the conversion from being lost.
 *
 * Only a lesson that went through the review is converted. A draft in `lezioni/` stops the conversion instead of shipping its
 * exercises with no «perché» behind them.
 */

import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

/** The theme's name as the user reads it. The YAML carries the key, not the title. */
export const THEMES: Readonly<Record<string, string>> = {
  "agenti-llm": "Agenti e LLM",
  ai: "AI",
  cybersecurity: "Cybersecurity",
  harness: "Harness",
}

/** What the JSON says it is, so a page served from an older ADE can say so instead of guessing. */
export const CONTENT_VERSION = 1

/** A lesson as it is written and as it is served: the YAML, read. Its fields are the schema's. */
export type Lesson = Record<string, unknown>

export interface LearnContent {
  v: number
  percorsi: { tema: string; titolo: string; lezioni: Lesson[] }[]
}

/** `/` never decides an order: the file list is compared as text, so two machines read the same order. */
const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/** Every YAML of the lessons, as paths relative to `root` with forward slashes, in a fixed order. */
export function lessonFiles(root: string, prefix = ""): string[] {
  const found: string[] = []
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) found.push(...lessonFiles(root, relative))
    else if (entry.name.endsWith(".yaml")) found.push(relative)
  }
  return found.sort(byText)
}

/**
 * One lesson, read. Throws when it is not one: invalid YAML, a document that is not an object, or a state that is not past the review.
 */
export function parseLesson(text: string, name: string): Lesson {
  let parsed: unknown
  try {
    parsed = Bun.YAML.parse(text)
  } catch (error) {
    throw new Error(`${name}: YAML non valido: ${(error as Error).message}`)
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${name}: la lezione non è un documento`)
  const lesson = parsed as Lesson
  const stato = lesson.stato
  if (stato !== "rivista" && stato !== "pubblicata") {
    throw new Error(`${name}: stato ${String(stato)}: in content.json entra solo una lezione rivista`)
  }
  return lesson
}

/** Every lesson of `root`, by theme: the themes in alphabetical order, and inside each theme the lessons by number. */
export function convert(root: string): LearnContent {
  const themes = new Map<string, Lesson[]>()
  for (const file of lessonFiles(root)) {
    const lesson = parseLesson(readFileSync(join(root, file), "utf8"), file)
    const tema = String(lesson.tema ?? "")
    const of = themes.get(tema)
    if (of) of.push(lesson)
    else themes.set(tema, [lesson])
  }
  return {
    v: CONTENT_VERSION,
    percorsi: [...themes.entries()]
      .sort(([a], [b]) => byText(a, b))
      .map(([tema, lezioni]) => ({
        tema,
        titolo: THEMES[tema] ?? tema,
        lezioni: lezioni.sort((a, b) => Number(a.numero) - Number(b.numero) || byText(String(a.id), String(b.id))),
      })),
  }
}

/** The text of `content.json`, exactly as it is written: two spaces and a final newline, so the diff is about the lessons. */
export function toJson(content: LearnContent): string {
  return `${JSON.stringify(content, null, 2)}\n`
}