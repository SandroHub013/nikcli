import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/*
 * Two things from the 2026-11-02 audit's rebrand list and token plan:
 *
 * - the ragu agent tile was Tailwind blue (#2563eb) while its mark is the
 *   pomodoro pot, against the rule written above the palettes («tinted with
 *   its brand colour, the one its mark is drawn in»); it wears pomodoro now;
 * - tint, border and glow of every vendor tile were typed by hand, about 45
 *   literals; they are derived from `--cli-color` with color-mix in one rule.
 */
const css = readFileSync(join(import.meta.dir, "session-new.css"), "utf8")
const body = css.replace(/\/\*[\s\S]*?\*\//g, "")

test("the ragu tile is pomodoro, not blue", () => {
  const block = /\[data-agent-id="ragu"\]\s*\{([^}]*)\}/.exec(body)?.[1] ?? ""
  expect(block).toMatch(/--cli-color:\s*light-dark\(#b83321,\s*#e86e48\)/)
  expect(block).toMatch(/--cli-contrast:\s*light-dark\(#fffaf0,\s*#120d0b\)/)
  expect(css).not.toMatch(/#2563eb|#3b82f6/i)
})

test("no vendor writes its own tint, border or glow", () => {
  const literal = [...body.matchAll(/--cli-(tint|border|glow):\s*([^;]+);/g)]
    .map((match) => `--cli-${match[1]}: ${match[2]}`)
    .filter((declaration) => !/color-mix\(in srgb, var\(--cli-color\)/.test(declaration))
  expect(literal).toEqual([])
})

test("one rule derives all three from the tile's colour", () => {
  const rule = /\[data-agent-id\]\s*\{([^}]*)\}/.exec(body)?.[1] ?? ""
  for (const name of ["tint", "border", "glow"]) {
    expect(rule).toMatch(new RegExp(`--cli-${name}:\\s*color-mix\\(in srgb, var\\(--cli-color\\) \\d+%, transparent\\)`))
  }
})
