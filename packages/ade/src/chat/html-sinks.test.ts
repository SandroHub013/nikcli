import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

/*
 * C5: nothing a model or a project writes reaches the chat as HTML. The
 * components cannot run under `bun test`, so the sources are read: no way to
 * parse or inject markup anywhere in `chat/`, comments stripped so a note
 * about it does not count.
 */

const DIR = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")
const SINKS = [
  /innerHTML/,
  /outerHTML/,
  /insertAdjacentHTML/,
  /DOMParser/,
  /createContextualFragment/,
  /srcdoc/,
  /document\.write/,
  /dangerouslySetInnerHTML/,
  /\bmarked\b/,
  /\bDOMPurify\b/,
]

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === "fixtures" ? [] : sources(path)
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : []
  })
}

describe("the chat's sources", () => {
  test("have no way to turn text into markup", () => {
    const files = sources(DIR)
    expect(files.some((file) => file.endsWith("parts.tsx"))).toBe(true)
    for (const file of files) {
      const code = readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1")
      for (const sink of SINKS) expect([file, sink.test(code)]).toEqual([file, false])
    }
  })
})
