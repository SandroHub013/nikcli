import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

/**
 * Which buttons have moved onto the shared primitives, and which sheets no longer carry a copy of them.
 *
 * Read from the sources, because the claim is about how a surface is written: a `<button data-slot="x">` that
 * comes back is a button with its own height, radius, ground, press and disabled look again (DS-8). Each surface
 * lists the slots that are `Button` or `IconButton` now, and the declarations its sheet must not repeat.
 */
const SRC = new URL("..", import.meta.url)
const read = (path: string) => readFileSync(new URL(path, SRC), "utf8").replace(/\r\n/g, "\n")
const withoutComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "")

/** The rule bodies for a selector, comments stripped. */
function bodies(css: string, selector: string): string[] {
  const text = withoutComments(css)
  const found: string[] = []
  for (let at = text.indexOf(`${selector} {`); at >= 0; at = text.indexOf(`${selector} {`, at + 1)) {
    found.push(text.slice(at, text.indexOf("}", at)))
  }
  return found
}

interface Surface {
  name: string
  /** Files where the slots are drawn. */
  tsx: string[]
  /** Slots that are a primitive now: no raw `<button>` may carry them. */
  slots: string[]
  css: string[]
  /** Declarations a migrated slot's sheet must not spell: the primitive decides them. */
  forbidden?: RegExp
}

const REDRAWN = /(^|\n)\s*(height|min-height|border-radius|background|border|font-size|font-weight|cursor|transition):/

const SURFACES: Surface[] = [
  {
    name: "settings",
    tsx: ["settings/shell.tsx", "settings/account.tsx", "settings/sections.tsx"],
    slots: ["settings-check-update", "settings-close", "settings-done", "switch-continue", "switch-cancel"],
    css: ["settings/shell.css", "settings/sections.css"],
    forbidden: REDRAWN,
  },
]

for (const surface of SURFACES) {
  describe(`${surface.name} is on the shared Button`, () => {
    test("no raw <button> carries a migrated slot", () => {
      for (const file of surface.tsx) {
        const source = withoutComments(read(file))
        for (const slot of surface.slots) {
          const raw = [...source.matchAll(/<button\b[^>]*>/g)].filter((match) => match[0].includes(`"${slot}"`))
          expect({ file, slot, raw: raw.length }).toEqual({ file, slot, raw: 0 })
        }
      }
    })

    test("its sheet no longer redraws the button", () => {
      for (const file of surface.css) {
        const css = read(file)
        for (const slot of surface.slots) {
          for (const body of bodies(css, `[data-slot="${slot}"]`)) {
            expect({ file, slot, body: surface.forbidden?.test(body) ? body : "" }).toEqual({ file, slot, body: "" })
          }
        }
      }
    })
  })
}
