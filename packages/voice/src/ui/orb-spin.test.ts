import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { DialogStatus } from "../dialog/session"
import { orbSpins } from "./orb-spin"

const STATUSES: DialogStatus[] = ["asleep", "idle", "listening", "confirming", "dictating", "executing"]
const css = readFileSync(join(import.meta.dir, "orb-mark.css"), "utf8")
const tsx = readFileSync(join(import.meta.dir, "orb-mark.tsx"), "utf8")

describe("when the arcs turn", () => {
  test("only while the voice listens, waits for an answer, or carries one out", () => {
    expect(STATUSES.filter((status) => orbSpins(true, status))).toEqual(["listening", "confirming", "executing"])
  })

  test("never with the microphone shut, whatever the dialogue says", () => {
    for (const status of STATUSES) expect(orbSpins(false, status)).toBe(false)
  })

  test("not in dictation: the words go through untouched and the orb holds still", () => {
    for (const status of STATUSES) expect(orbSpins(true, status, "transcription")).toBe(false)
    expect(orbSpins(true, "listening", "assistant")).toBe(true)
  })
})

describe("the stylesheet and the drawing agree with it", () => {
  test("the orb says whether it spins, and the arcs and the iris are held whenever it does not, not only when the microphone is shut", () => {
    expect(tsx).toContain("data-spin")
    expect(tsx).toContain("orbSpins(")
    expect(css).toMatch(/:not\(\[data-spin\]\) \[data-slot="orb-swirl"\] \{\s*animation-play-state: paused;/)
    // The iris' rule comes after the one that sets its `animation` (the shorthand sets the play state), or it would not hold.
    const breathes = css.indexOf("animation: ade-orb-breathe")
    const held = css.indexOf(':not([data-spin]) [data-slot="orb-iris"] {')
    expect(breathes).toBeGreaterThan(0)
    expect(held).toBeGreaterThan(breathes)
    expect(css.slice(held, held + 120)).toContain("animation-play-state: paused;")
    // The old rule kept them turning for as long as the microphone was open.
    expect(css).not.toMatch(/:not\(\[data-awake\]\) \[data-slot="orb-swirl"\] \{\s*animation-play-state/)
  })

  test("an open microphone that does not turn shows its arcs faint, like the eye that waits for the wake word", () => {
    expect(css).toMatch(
      /\[data-component="orb-mark"\]\[data-awake\]:not\(\[data-spin\]\) \[data-slot="orb-swirl"\] \{\s*opacity: 0\.12;/,
    )
  })

  test("reduced motion still stops the arcs and the iris outright", () => {
    const block = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"))
    expect(block).toMatch(
      /\[data-slot="orb-swirl"\],\s*\[data-component="orb-mark"\] \[data-slot="orb-iris"\] \{\s*animation: none;/,
    )
  })
})
