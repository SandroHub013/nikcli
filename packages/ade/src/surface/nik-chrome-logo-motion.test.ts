import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { POINTER_IDLE_MS, SHEEN_MS, loopWanted, type LoopState } from "./nik-chrome-logo-motion"

const source = readFileSync(join(import.meta.dir, "nik-chrome-logo.tsx"), "utf8")
const style = source.slice(source.indexOf("<style>{`"), source.indexOf("`}</style>"))

const at = (over: Partial<LoopState>): LoopState => ({
  now: 10_000,
  introUntil: 2_000,
  pointerInside: false,
  lastPointerAt: 0,
  settled: true,
  ...over,
})

describe("when the mark's physics loop asks for a frame", () => {
  test("during the intro, and while the springs move, whatever the pointer does", () => {
    expect(loopWanted(at({ now: 1_000 }))).toBe(true)
    expect(loopWanted(at({ settled: false }))).toBe(true)
  })

  test("at rest and with no pointer on it, never", () => {
    expect(loopWanted(at({}))).toBe(false)
  })

  test("a pointer that moves on the mark keeps it going, a pointer parked on it does not", () => {
    // The old rule: «the pointer is inside» kept the loop, and with it the sheen, for as long as the pointer stayed.
    expect(loopWanted(at({ pointerInside: true, lastPointerAt: 10_000 - 100 }))).toBe(true)
    expect(loopWanted(at({ pointerInside: true, lastPointerAt: 10_000 - POINTER_IDLE_MS - 1 }))).toBe(false)
    expect(loopWanted(at({ pointerInside: true, lastPointerAt: 0, now: 3_600_000 }))).toBe(false)
  })

  test("a pointer that left does not keep it going however recently it moved", () => {
    expect(loopWanted(at({ pointerInside: false, lastPointerAt: 10_000 }))).toBe(false)
  })
})

describe("the sheen of the mark", () => {
  test("is one pass on an event, never an animation that loops: it cost about 28 % of a core in the title bar", () => {
    expect(style).not.toMatch(/infinite/)
    expect(style).toMatch(
      /\[data-sheen\] \.nik-sheen-sweep \{\s*animation: chromeSheenPass \$\{SHEEN_MS\}ms ease-out 1;/,
    )
    expect(SHEEN_MS).toBeGreaterThan(300)
  })

  test("at rest the stroke shows the frame the pass ends on, so the end of a pass does not jump", () => {
    expect(style).toMatch(/\.nik-sheen-sweep \{\s*stroke-dasharray: 45 110;\s*stroke-dashoffset: 0;\s*opacity: 0\.95;/)
    expect(style).toMatch(/100% \{ stroke-dashoffset: 0; opacity: 0\.95; \}/)
  })

  test("asks for nothing at rest: no animation is named outside a pass, and the pass is taken off when it ends", () => {
    const outside = style.replace(
      /\[data-component="nik-chrome-logo"\]\[data-sheen\] \.nik-sheen-sweep \{\s*animation: [^;]*;\s*\}/,
      "",
    )
    expect(outside.match(/animation:\s*(?!none)\S/g) ?? []).toEqual([])
    expect(source).toContain('containerRef.setAttribute("data-sheen", "")')
    expect(source).toContain('containerRef?.removeAttribute("data-sheen")')
    expect(source).toContain('el.addEventListener("animationend", onSheenEnd)')
  })

  test("it starts on the intro, on entering the mark and on a click, and not on every movement", () => {
    const enter = source.slice(source.indexOf("const onMouseEnter"), source.indexOf("const onMouseLeave"))
    const move = source.slice(source.indexOf("const onMouseMove"), source.indexOf("const onMouseEnter"))
    const click = source.slice(source.indexOf("const onClick"), source.indexOf("const el = containerRef"))
    expect(enter).toContain("sheen()")
    expect(click).toContain("sheen()")
    expect(move).not.toContain("sheen()")
    expect(source).toContain("    start()\n    sheen()\n")
  })

  test("with reduced motion it does not move at all and keeps the resting frame", () => {
    const block = style.slice(style.indexOf("@media (prefers-reduced-motion: reduce)"))
    expect(block).toMatch(/animation: none;\s*stroke-dashoffset: 0;\s*opacity: 0\.95;/)
    expect(source).toContain("if (reducedMotion || !containerRef || sheenPass) return")
  })

  test("a pass whose end never comes is ended by a timer, so the next one can start", () => {
    expect(source).toContain("setTimeout(onSheenEnd, SHEEN_MS + 300)")
  })
})
