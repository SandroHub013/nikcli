import { expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"

/*
 * Weights come from the scale (polish-aaa B6): `--ade-weight-normal|medium|semibold|bold`.
 * The Decisions and Design cards are left out for now: pieces A2 and A3 rewrite them.
 */

const SRC = import.meta.dir
const LATER = new Set(["decisions/decisions.css", "design/design.css"])

function cssFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return cssFiles(path)
    return name.endsWith(".css") ? [path] : []
  })
}

test("every font weight in the CSS is a token", () => {
  const loose: string[] = []
  for (const path of cssFiles(SRC)) {
    const file = relative(SRC, path).replace(/\\/g, "/")
    if (LATER.has(file)) continue
    readFileSync(path, "utf-8")
      .split("\n")
      .forEach((line, index) => {
        const weight = /font-weight:\s*([^;]+);/.exec(line)?.[1]?.trim()
        const shorthand = /\bfont:\s*(\d{3}|bold)\s/.exec(line)?.[1]
        if ((weight && !/^var\(--ade-weight-(normal|medium|semibold|bold)\)$/.test(weight) && weight !== "inherit") || shorthand) {
          loose.push(`${file}:${index + 1} ${line.trim()}`)
        }
      })
  }
  expect(loose).toEqual([])
})
