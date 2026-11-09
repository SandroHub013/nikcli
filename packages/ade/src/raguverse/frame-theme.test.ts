import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { frameTheme } from "./frame-theme"
import { worldQuery } from "./opening"
import { raguTokensBlock, withBlock, BEGIN, END } from "./ragu-tokens"
import { readOptions } from "./world/world.js"
import { readTheme } from "./learn/page/learn.js"

/*
 * DS-25 (2026-11-02 audit), the user's choice B: the 3D city keeps its colours;
 * Impara and the world's chrome wear the ragù palette and follow ADE's theme,
 * not the OS one (ADE in light on a dark OS showed a dark Raguverse).
 */
const here = import.meta.dir
const index = readFileSync(join(here, "..", "index.css"), "utf8")
const learn = readFileSync(join(here, "learn/page/learn.css"), "utf8")
const world = readFileSync(join(here, "world/world.css"), "utf8")
const learnFrame = readFileSync(join(here, "learn/learn-frame.tsx"), "utf8")
const pane = readFileSync(join(here, "raguverse-pane.tsx"), "utf8")

function shell(theme?: string) {
  document.body.innerHTML = theme ? `<div data-component="ade-shell" data-theme="${theme}"></div>` : ""
}

describe("what ADE tells the frames", () => {
  test("the resolved theme of the shell, glass counted as dark", () => {
    shell("light")
    expect(frameTheme()).toBe("light")
    shell("dark")
    expect(frameTheme()).toBe("dark")
    shell("glass")
    expect(frameTheme()).toBe("dark")
    shell()
    expect(frameTheme()).toBe("dark")
  })

  test("the world's address carries it, and an address without one is what it was", () => {
    expect(worldQuery({ theme: "light" })).toBe("?theme=light")
    expect(worldQuery({ bench: "bench=1", list: true, theme: "dark" })).toBe("?bench=1&city=0&theme=dark")
    expect(worldQuery({})).toBe("")
  })

  test("the world reads it, and nothing else but light and dark", () => {
    expect(readOptions("?theme=light").theme).toBe("light")
    expect(readOptions("?theme=dark").theme).toBe("dark")
    expect(readOptions("?theme=pink").theme).toBeUndefined()
    expect(readOptions("").theme).toBeUndefined()
  })

  test("the lesson page reads it from the fragment", () => {
    expect(readTheme("#n=abc&l=en&t=light")).toBe("light")
    expect(readTheme("#n=abc&t=dark")).toBe("dark")
    expect(readTheme("#n=abc&t=pink")).toBeUndefined()
    expect(readTheme("#n=abc")).toBeUndefined()
  })

  test("both hosts put the theme in the address", () => {
    expect(learnFrame).toMatch(/&t=\$\{theme\}/)
    expect(learnFrame).toMatch(/learnSource\(nonce, props\.place, locale\(\), frameTheme\(\)\)/)
    expect(pane).toMatch(/theme: frameTheme\(\)/)
  })
})

describe("the frames wear the ragù palette (DS-25)", () => {
  test("each sheet starts from the block generated from index.css, and is in step with it", () => {
    for (const sheet of [learn, world]) {
      expect(sheet).toContain(BEGIN)
      expect(withBlock(sheet, raguTokensBlock(index))).toBe(sheet)
    }
  })

  test("the block carries both schemes of the palette", () => {
    const block = raguTokensBlock(index)
    expect(block).toContain("--ade-bg: #120d0b;")
    expect(block).toContain("--ade-bg: #f4e7cd;")
    expect(block).toContain("--ade-accent: #e86e48;")
    expect(block).toContain("--ade-accent: #b83321;")
    expect(block).toContain("--ade-state-perm: var(--ade-waiting);")
    expect(block.indexOf(BEGIN)).toBeLessThan(block.indexOf(END))
  })

  test("no slate, no GitHub blue, no OS scheme", () => {
    for (const sheet of [learn, world]) {
      const body = sheet.replace(/\/\*[\s\S]*?\*\//g, "")
      expect(body).not.toMatch(/prefers-color-scheme/)
      for (const gone of ["#14161a", "#1d2026", "#6aa9ff", "#1f6feb", "#4ade80", "#f87171", "#fbbf24", "#f4f5f7"]) {
        expect(body.toLowerCase()).not.toContain(gone)
      }
    }
  })

  /*
   * A frame is a document of its own and cannot read index.css, so `tokens-declared.test.ts` (which counts a
   * declaration anywhere under src) cannot see a name missing from it. `--ade-z-base` was: used by world.css, never
   * given a value there (the review of this branch, B2).
   */
  test("every --ade-* a frame sheet uses is declared in that same sheet", () => {
    for (const [name, sheet] of [["learn.css", learn], ["world.css", world]] as const) {
      const body = sheet.replace(/\/\*[\s\S]*?\*\//g, "")
      const declared = new Set([...body.matchAll(/(--ade-[a-z0-9-]+)\s*:/g)].map((match) => match[1]))
      const missing = [...body.matchAll(/var\(\s*(--ade-[a-z0-9-]+)/g)].map((match) => match[1]!).filter((used) => !declared.has(used))
      expect([name, [...new Set(missing)]]).toEqual([name, []])
    }
  })

  test("the frame's own names read the palette", () => {
    for (const sheet of [learn, world]) {
      expect(sheet).toMatch(/--bg:\s*var\(--ade-bg\)/)
      expect(sheet).toMatch(/--accent:\s*var\(--ade-accent\)/)
      expect(sheet).toMatch(/--err:\s*var\(--ade-state-err\)/)
    }
  })

  /* DS2-1: the DS-25 port mapped Impara's success by name, so a right answer wore «Al lavoro»'s amber. */
  test("Impara draws success in the done green, never in the working amber", () => {
    const body = learn.replace(/\/\*[\s\S]*?\*\//g, "")
    expect(body).toMatch(/--ok:\s*var\(--ade-done\)/)
    expect(body).not.toMatch(/var\(--work\)/)
    expect(body).not.toContain("--work:")
  })
})
