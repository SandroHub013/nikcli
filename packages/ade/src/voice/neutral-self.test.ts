import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

/*
 * The same rule as packages/voice/src/neutral-self.test.ts, for the lines of the voice that live in ADE: the voice
 * says nothing about its own gender (the default voice is a man's, Rosa's is a woman's).
 */
const SELF_GENDER = /\b(?:[Nn]on )?[Ss]ono (?:riuscit[oa]|svegli[oa]|pront[oa])\b|\bADE non è riuscit[oa]\b/

describe("the voice's lines in ADE carry no gender about itself", () => {
  test("no source in src/voice has one", () => {
    const offenders = readdirSync(import.meta.dir).filter(
      (name) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && SELF_GENDER.test(readFileSync(join(import.meta.dir, name), "utf8")),
    )
    expect(offenders).toEqual([])
  })
})
