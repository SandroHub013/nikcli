import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join, relative } from "node:path"
import ts from "typescript"

/*
 * A ratchet on the text written straight into JSX (S41).
 *
 * Counts, per `.tsx` file, the JSX text and the user-facing attributes that
 * are fixed strings rather than `t(…)`. The count may only go down: a file
 * above its baseline has gained an untranslated text, and a file below it has
 * lost some and should say so, so the next regression is caught at the new
 * level. `ADE_I18N_BASELINE=write bun run test:unit` rewrites the baseline.
 */

const SRC = join(import.meta.dir, "..")
const BASELINE = join(import.meta.dir, "hardcoded-baseline.json")

const UI_ATTRIBUTES = new Set([
  "title",
  "aria-label",
  "placeholder",
  "alt",
  "label",
  "emptyLabel",
  "subtitle",
  "description",
])

/** Names and symbols that read the same in any language. */
const NEUTRAL = /^(?:ADE|nik|nikcli|ssh|MCP|git|GitHub|OpenRouter|Codex|Claude Code)$/

function sources(dir: string, into: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      if (name !== "node_modules") sources(path, into)
    } else if (name.endsWith(".tsx") && !name.includes(".test.")) into.push(path)
  }
  return into
}

const isText = (text: string) => /\p{L}{2,}/u.test(text) && !NEUTRAL.test(text)

function count(path: string): number {
  const file = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let found = 0
  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node)) {
      if (isText(node.getText().replace(/\s+/g, " ").trim())) found++
    } else if (ts.isJsxAttribute(node) && node.initializer && UI_ATTRIBUTES.has(node.name.getText())) {
      const init = node.initializer
      const literal = ts.isStringLiteral(init)
        ? init.text
        : ts.isJsxExpression(init) && init.expression && ts.isStringLiteral(init.expression)
          ? init.expression.text
          : undefined
      if (literal !== undefined && isText(literal.trim())) found++
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

function measure(): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const path of sources(SRC).sort()) {
    const n = count(path)
    if (n > 0) counts[relative(SRC, path).replace(/\\/g, "/")] = n
  }
  return counts
}

describe("fixed text in JSX", () => {
  test("does not grow, and the baseline follows it down", () => {
    const now = measure()
    if (process.env.ADE_I18N_BASELINE === "write") {
      writeFileSync(BASELINE, JSON.stringify(now, null, 2) + "\n")
      return
    }
    const baseline = JSON.parse(readFileSync(BASELINE, "utf8")) as Record<string, number>
    const grew: string[] = []
    const shrank: string[] = []
    for (const file of new Set([...Object.keys(now), ...Object.keys(baseline)])) {
      const was = baseline[file] ?? 0
      const is = now[file] ?? 0
      if (is > was) grew.push(`${file}: ${was} → ${is} (use t() from src/i18n)`)
      if (is < was) shrank.push(`${file}: ${was} → ${is} (lower the baseline: ADE_I18N_BASELINE=write)`)
    }
    expect(grew).toEqual([])
    expect(shrank).toEqual([])
  })
})
