import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { Glob } from "bun"
import { MONO_STACK } from "./terminal/registry"

/*
 * DS-15 (2026-11-02 audit), the user's choice B «Caratteri di sistema»: ADE
 * declared Inter and IBM Plex Mono and shipped neither, so the type scale had
 * been tuned for whichever font the developer had installed, and the chrome
 * and the terminal asked for different monos. It now says what it draws in:
 * Segoe UI Variable and Cascadia Mono on Windows, SF on a Mac, one mono for
 * both the chrome and the terminal.
 *
 * The 10px step is retuned for those faces (DS-20's floor): Segoe UI Variable
 * is drawn for 11 and 12px, and 10px is where its counters close up.
 */
const dir = import.meta.dir
const css = readFileSync(join(dir, "index.css"), "utf8")

function stack(name: string): string[] {
  const match = new RegExp(`${name}:\\s*([^;]+);`).exec(css)
  if (!match) throw new Error(`${name} not declared in index.css`)
  return match[1]!
    .split(",")
    .map((family) => family.trim().replace(/^["']|["']$/g, ""))
}

describe("the fonts ADE draws in (DS-15)", () => {
  test("the text is Segoe UI Variable first, SF on a Mac, then the system", () => {
    const sans = stack("--ade-sans")
    expect(sans[0]).toBe("Segoe UI Variable Text")
    expect(sans).toContain("Segoe UI")
    expect(sans).toContain("system-ui")
    expect(sans.at(-1)).toBe("sans-serif")
  })

  test("the mono is Cascadia Mono, then SF Mono, with glyph fallbacks for the agents' TUIs", () => {
    const mono = stack("--ade-mono")
    expect(mono.slice(0, 2)).toEqual(["Cascadia Mono", "SF Mono"])
    expect(mono).toContain("Consolas")
    // Spinners and marks (✻ ⏺ ⎿) that Cascadia lacks arrive from a symbol face, not tofu.
    expect(mono).toContain("Segoe UI Symbol")
    expect(mono.at(-1)).toBe("monospace")
  })

  test("the terminal asks for the same mono as the chrome", () => {
    const terminal = MONO_STACK.split(",").map((family) => family.trim().replace(/^["']|["']$/g, ""))
    expect(terminal).toEqual(stack("--ade-mono"))
  })

  test("nothing under src asks for a font that is not shipped", () => {
    const offenders = [...new Glob("**/*.{css,ts,tsx}").scanSync(dir)]
      .filter((file) => !/\.test\.tsx?$/.test(file))
      .flatMap((file) => {
        const text = readFileSync(join(dir, file), "utf8")
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/^\s*\/\/.*$/gm, "")
        return [...text.matchAll(/["']?(Inter|IBM Plex Mono|JetBrains Mono)["']?\s*,/g)].map(
          (match) => `${file.replaceAll("\\", "/")}: ${match[1]}`,
        )
      })
    expect(offenders).toEqual([])
    expect(css).not.toMatch(/@font-face/)
  })
})

describe("the 10px step, retuned (DS-15, DS-20)", () => {
  /** A size in px; `--ade-font-xs` may be a name for another step (DS2-10), which is followed once. */
  const px = (name: string): number => {
    const match = new RegExp(`${name}:\\s*(?:(\\d+)px|var\\((--ade-font-[a-z0-9]+)\\));`).exec(css)
    return match?.[1] ? Number(match[1]) : match?.[2] ? px(match[2]) : Number.NaN
  }

  test("the smallest text is 11px", () => {
    expect(px("--ade-font-xs")).toBeGreaterThanOrEqual(11)
  })

  test("the steps still climb", () => {
    const steps = ["xs", "sm", "md", "lg", "xl", "2xl", "3xl"].map((step) => px(`--ade-font-${step}`))
    expect(steps).toEqual([...steps].sort((a, b) => a - b))
  })

  test("body is the md step, not a second twelve", () => {
    expect(css).toMatch(/--ade-font-body:\s*var\(--ade-font-md\);/)
  })

  test("one tracking for the caps labels", () => {
    expect(css).toMatch(/--ade-track-caps:\s*0\.06em;/)
    const sheets = [...new Glob("**/*.css").scanSync(dir)].map((file) => ({
      file: file.replaceAll("\\", "/"),
      text: readFileSync(join(dir, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, ""),
    }))
    const loose = sheets.flatMap(({ file, text }) =>
      [...text.matchAll(/\{([^{}]*)\}/g)]
        .map((block) => block[1]!)
        .filter((body) => /text-transform:\s*uppercase/.test(body))
        .map((body) => /letter-spacing:\s*([^;]+);/.exec(body)?.[1]?.trim())
        .filter((spacing): spacing is string => !!spacing && spacing !== "var(--ade-track-caps)")
        .map((spacing) => `${file}: ${spacing}`),
    )
    expect(loose).toEqual([])
  })
})
