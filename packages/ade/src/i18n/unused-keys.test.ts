import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { it } from "./it"

/*
 * A key nobody reads is a text that is translated, kept in step and tested for
 * nothing (UX-25: about 31 of them had piled up, among them a splash caption
 * for a splash that no longer exists). This stops a new one: a key must be
 * written out as a literal somewhere in the app, or be built from a prefix
 * that is (`t(`decisions.status.${status}`)`).
 *
 * The voice texts (`vui.*`) are read by `@ragu/voice` through the same catalog;
 * its sources are searched too.
 */
const SRC = join(import.meta.dir, "..")
const VOICE = join(import.meta.dir, "..", "..", "..", "voice", "src")

function sources(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "i18n") continue
      found.push(...sources(path))
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\./.test(entry.name)) found.push(path)
  }
  return found
}

describe("the Italian catalog", () => {
  test("has no key that nothing reads", () => {
    const text = [...sources(SRC), ...sources(VOICE)].map((path) => readFileSync(path, "utf8")).join("\n")
    const prefixes = new Set<string>()
    // The prefix must hold a dot: a bare `n${...}` or `s${...}` once made 403 keys pass without being read.
    for (const match of text.matchAll(/[`"']([A-Za-z0-9_-]+\.[A-Za-z0-9_.-]*)\$\{/g)) prefixes.add(match[1]!)
    const unused = Object.keys(it).filter((key) => {
      if (text.includes(`"${key}"`) || text.includes(`'${key}'`) || text.includes(`\`${key}\``)) return false
      return ![...prefixes].some((prefix) => key.startsWith(prefix))
    })
    expect(unused).toEqual([])
    // Reads every source file of ade and voice: on a cold disk 5 s is not enough.
  }, 30_000)
})
