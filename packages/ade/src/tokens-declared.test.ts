import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { Glob } from "bun"

/*
 * DS-2 (2026-11-02 audit): seven `var(--ade-*)` names were used and never
 * defined, and they rendered wrong (window buttons at full text strength, the
 * Raguverse borders in the text colour, six sheets on `ui-monospace`, a failed
 * space notice that was not red). A name is declared when a stylesheet
 * (`--ade-x: ...`) or a script (`setProperty("--ade-x", ...)`, a style object
 * key) gives it a value somewhere under src.
 */
const dir = import.meta.dir
const files = [...new Glob("**/*.{css,ts,tsx}").scanSync(dir)]
  .filter((file) => !file.endsWith(".test.ts") && !file.endsWith(".test.tsx"))
  .map((file) => ({
    file: file.replaceAll("\\", "/"),
    text: readFileSync(join(dir, file), "utf8"),
  }))

/** Names a component takes from its caller, with a fallback in the sheet; not tokens. */
const INPUTS: Record<string, string> = {
  "--ade-grid-min": "the minimum track of ui/layout.tsx Grid, set in style by the caller, 160px otherwise",
}

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "")
}

function declared(): Set<string> {
  const names = new Set<string>()
  for (const { file, text } of files) {
    const body = file.endsWith(".css") ? stripComments(text) : text
    for (const match of body.matchAll(/(?:^|[;{\s"'`])(--ade-[a-z0-9-]+)\s*(?::|["'`]\s*,)/g)) names.add(match[1]!)
    for (const match of body.matchAll(/setProperty\(\s*["'`](--ade-[a-z0-9-]+)["'`]/g)) names.add(match[1]!)
    for (const match of body.matchAll(/["'`](--ade-[a-z0-9-]+)["'`]\s*:/g)) names.add(match[1]!)
  }
  return names
}

function used(): Map<string, string[]> {
  const found = new Map<string, string[]>()
  for (const { file, text } of files) {
    const body = file.endsWith(".css") ? stripComments(text) : text
    for (const match of body.matchAll(/var\(\s*(--ade-[a-z0-9-]+)/g)) {
      const name = match[1]!
      if (name.endsWith("-") || name in INPUTS) continue // `--ade-ansi-${color}`: a family, checked by its members
      const list = found.get(name) ?? []
      if (!list.includes(file)) list.push(file)
      found.set(name, list)
    }
  }
  return found
}

describe("design tokens (DS-2)", () => {
  test("every var(--ade-*) used under src is declared somewhere under src", () => {
    const have = declared()
    const missing = [...used()].filter(([name]) => !have.has(name)).map(([name, where]) => `${name} (${where.join(", ")})`)
    expect(missing).toEqual([])
  })

  test("the seven names the audit found are gone from use", () => {
    const names = used()
    for (const gone of [
      "--ade-text-subtle",
      "--ade-text-dim",
      "--ade-line",
      "--ade-font-mono",
      "--ade-danger",
      "--ade-done-border",
    ]) {
      expect(names.has(gone)).toBe(false)
    }
  })
})
