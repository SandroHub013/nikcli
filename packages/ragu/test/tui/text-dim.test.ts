import { describe, expect, test } from "bun:test"
import { TUI_SRC, tuiSource } from "./tui-source"

/**
 * DIM only on the default text colour (P0 #2 of the triple-A review).
 *
 * DIM is the terminal's own attenuation, about half the contrast. On `foreground.muted` or `subtle`, colours already
 * chosen as the quieter ones, it dims twice: the «navigate · select · close» hints of every dialog fell to 2.8:1. On an
 * error it makes the one line that must be read the faintest on screen. So the colour of an element with DIM has to be
 * the default text, and nothing else.
 */

/** Where a token, not the element, decides the colour, and the token defaults to the text colour. */
const TOKEN_COLOURED: Record<string, string> = {
  "component/session-task-card.tsx": "the title's colour is the `session.task-card` token, foreground.default",
}

const ALLOWED = /^(?:[\w.]+\.)?(?:foreground\.default|text)$/

/** The expression after `fg={` or `fg:` at `start`, to its closing brace or comma at depth 0. */
function expressionAt(line: string, start: number): string {
  let depth = 0
  let out = ""
  for (const ch of line.slice(start)) {
    if (ch === "{" || ch === "(" || ch === "[") depth++
    if (ch === "}" || ch === ")" || ch === "]") {
      if (depth === 0) break
      depth--
    }
    if (ch === "," && depth === 0) break
    out += ch
  }
  return out.trim()
}

function fgIn(line: string): string | undefined {
  const match = /\bfg(=\{|:\s*)/.exec(line)
  if (!match) return undefined
  return expressionAt(line, match.index + match[0].length)
}

/** The colour of the element that carries DIM on `lines[at]`: its own line, else the lines of the same element. */
function colourOf(lines: string[], at: number): string | undefined {
  const own = fgIn(lines[at]!)
  if (own) return own
  for (let i = at - 1; i >= Math.max(0, at - 8); i--) {
    const fg = fgIn(lines[i]!)
    if (fg) return fg
    if (/<\w/.test(lines[i]!) || /return\s*\{|=\s*\{$/.test(lines[i]!)) break
  }
  for (let i = at + 1; i < Math.min(lines.length, at + 8); i++) {
    const fg = fgIn(lines[i]!)
    if (fg) return fg
    if (/^\s*\/?>/.test(lines[i]!) || /^\s*\}/.test(lines[i]!)) break
  }
  return undefined
}

describe("DIM", () => {
  test("is only ever on the default text colour", async () => {
    const offending: string[] = []
    let seen = 0
    for await (const file of new Bun.Glob("**/*.{ts,tsx}").scan({ cwd: TUI_SRC })) {
      const path = file.replaceAll("\\", "/")
      const lines = (await tuiSource(file)).split("\n")
      lines.forEach((line, i) => {
        if (!line.includes("TextAttributes.DIM")) return
        seen++
        if (path in TOKEN_COLOURED) return
        const colour = colourOf(lines, i)
        if (!colour || !ALLOWED.test(colour)) offending.push(`${path}:${i + 1} fg=${colour ?? "?"}`)
      })
    }
    // A scan that reads nothing passes vacuously: prove the attribute is still in the tree.
    expect(seen).toBeGreaterThan(0)
    expect(offending).toEqual([])
  })
})
