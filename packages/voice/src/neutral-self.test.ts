import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

/*
 * The voice says nothing about its own gender. The reply voice is the user's choice, and the default, Ugo, is a man's:
 * «Sono sveglia» in his mouth, or «Non sono riuscito» in Rosa's, is wrong for one of them. A line the voice speaks about
 * itself takes a neutral form: «Non riesco a…», «Eccomi, ti ascolto». The words it uses to RECOGNISE what the user says
 * (svegliati, torna attivo, …) are the user's and are not touched.
 */
export const SELF_GENDER = /\b(?:[Nn]on )?[Ss]ono (?:riuscit[oa]|svegli[oa]|pront[oa])\b|\bADE non è riuscit[oa]\b/

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sources(path)
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : []
  })
}

describe("the voice's own Italian lines carry no gender about itself", () => {
  test("the rule sees the forms it forbids, and not the neutral ones or a third person", () => {
    for (const bad of [
      "Non sono riuscito a farlo",
      "Non sono riuscita a farlo",
      "Sono sveglio e in ascolto",
      "Sono sveglia e in ascolto",
      "Sono pronto",
      "sono pronta",
      "ADE non è riuscita a farti la domanda",
    ]) {
      expect(SELF_GENDER.test(bad)).toBe(true)
    }
    for (const fine of ["Non riesco a farlo", "Eccomi, ti ascolto", "Ci sono", "il pannello non è pronto a ricevere testo"]) {
      expect(SELF_GENDER.test(fine)).toBe(false)
    }
  })

  test("no source of the voice package has one", () => {
    const offenders = sources(import.meta.dir).filter((path) => SELF_GENDER.test(readFileSync(path, "utf8")))
    expect(offenders.map((path) => path.slice(import.meta.dir.length + 1))).toEqual([])
  })
})
