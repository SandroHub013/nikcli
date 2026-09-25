import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

/*
 * C8: the chat talks to nikcli only. The OpenRouter path it had before the
 * store (a direct call with the voice settings' key) is gone, and nothing in
 * `chat/` reads that key again: it stays the voice's. The components cannot
 * run under `bun test`, so the sources are read, comments stripped so a note
 * about it does not count.
 */

const DIR = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")
const FORBIDDEN = [
  /openrouter\.ai/i,
  /\bopenRouterApiKey\b/,
  /\bapiKey\b/,
  /\bAuthorization\b/,
  /\bBearer\s/,
  /\bvoiceSettings\b/,
  /@nikcli-ai\/voice/,
  /\bstreamChat\b/,
]

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === "fixtures" ? [] : sources(path)
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : []
  })
}

const code = (file: string) =>
  readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")

describe("the chat and OpenRouter", () => {
  test("no source in chat/ calls OpenRouter or reads the voice's key", () => {
    const files = sources(DIR)
    expect(files.some((file) => file.endsWith("chat.tsx"))).toBe(true)
    for (const file of files) {
      const text = code(file)
      for (const pattern of FORBIDDEN) expect([file, pattern.test(text)]).toEqual([file, false])
    }
  })

  test("the workbench hands the chat no key", () => {
    const workbench = code(join(DIR, "..", "surface", "workbench.tsx"))
    const chat = workbench.match(/<Chat\b[\s\S]*?\/>/)
    expect(chat).not.toBeNull()
    expect(chat![0]).not.toMatch(/apiKey|openRouterApiKey|onOpenSettings/)
  })
})
