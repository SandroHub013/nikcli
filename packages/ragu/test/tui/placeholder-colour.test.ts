import { describe, expect, test } from "bun:test"
import { TUI_SRC, tuiSource } from "./tui-source"

/**
 * Every input and textarea with a placeholder names its colour.
 *
 * Without `placeholderColor` opentui paints it in its own fixed #666666, whatever the theme: 3:1 on the prompt of the
 * default dark theme («Chiedi qualsiasi cosa…» and the «Search» field of every dialog, the captures of the CLI UI
 * review), and on a light theme it depends on luck. `foreground.muted` is the colour each theme keeps at 4.5:1 on
 * every surface.
 */

/** The opening tag that starts at `start`: up to the first `>` outside braces that does not close an arrow. */
function openingTag(source: string, start: number): string {
  let depth = 0
  for (let i = start; i < source.length; i++) {
    const ch = source[i]
    if (ch === "{") depth++
    else if (ch === "}") depth--
    else if (ch === ">" && depth === 0 && source[i - 1] !== "=") return source.slice(start, i + 1)
  }
  return source.slice(start)
}

describe("placeholders", () => {
  test("every input and textarea with one gives it a theme colour", async () => {
    const missing: string[] = []
    let seen = 0
    for await (const file of new Bun.Glob("**/*.tsx").scan({ cwd: TUI_SRC })) {
      const source = await tuiSource(file)
      for (const match of source.matchAll(/<(input|textarea)\b/g)) {
        const tag = openingTag(source, match.index)
        if (!tag.includes("placeholder=")) continue
        seen++
        if (!/placeholderColor=\{[^}]*foreground\.muted\}/.test(tag)) {
          const line = source.slice(0, match.index).split("\n").length
          missing.push(`${file.replaceAll("\\", "/")}:${line} <${match[1]}>`)
        }
      }
    }
    // A scan that finds nothing passes vacuously: the prompt alone has one.
    expect(seen).toBeGreaterThan(10)
    expect(missing).toEqual([])
  })
})
