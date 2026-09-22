import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/*
 * The tile shell — column flex, ground, framelessness, focus line — lives
 * once, on the cell's child in index.css (S67.2).
 *
 * Five panes had each copied the same fifteen lines, and the copies drifted:
 * the video pane grew a hairline border that doubled the grid's one-pixel
 * gap, and only nobody noticing for a release kept it from being read as a
 * design. These assertions fail whichever pane starts rewriting the shell
 * for itself again, and fail if the shell is taken away — so a pane added
 * tomorrow is laid out by the cell, not by whoever remembers the incantation.
 */

const src = join(import.meta.dir, "..")
const read = (path: string) => readFileSync(join(src, path), "utf8")
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "")

/** What the shell owns on a pane root; a pane's own rules may not set it. */
const SHELL_OWNED = [
  "display",
  "flex-direction",
  "flex",
  "min-width",
  "min-height",
  "position",
  "overflow",
  "background",
  "outline",
  "border",
  "border-radius",
]

const PANE_ROOT = /^\[data-component="[\w-]+-pane"\](\[data-focused(="true")?\])?$/

/** The declarations of every rule whose selector is exactly a pane root. */
function paneRootBodies(): { where: string; selector: string; body: string }[] {
  const found: { where: string; selector: string; body: string }[] = []
  for (const entry of new Bun.Glob("**/*.css").scanSync(src)) {
    const file = entry.replace(/\\/g, "/")
    const css = strip(readFileSync(join(src, file), "utf8"))
    for (const rule of css.split("}")) {
      const at = rule.indexOf("{")
      if (at < 0) continue
      const selector = rule.slice(0, at).trim()
      if (!PANE_ROOT.test(selector)) continue
      found.push({ where: `${file}: ${selector}`, selector, body: rule.slice(at + 1) })
    }
  }
  return found
}

describe("the pane shell stays in one place", () => {
  test("no pane root re-declares the shell's geometry, ground or frame", () => {
    const rebels: string[] = []
    for (const { where, body } of paneRootBodies()) {
      for (const line of body.split("\n")) {
        const prop = line.split(":")[0]?.trim() ?? ""
        if (SHELL_OWNED.includes(prop)) rebels.push(`${where}: ${line.trim()}`)
      }
    }
    expect(rebels).toEqual([])
  })

  test("no pane root draws its own focus treatment", () => {
    const rebels: string[] = []
    for (const { where, selector, body } of paneRootBodies()) {
      if (!selector.includes("[data-focused")) continue
      for (const line of body.split("\n")) {
        const prop = line.split(":")[0]?.trim() ?? ""
        if (prop === "outline" || prop.startsWith("border")) rebels.push(`${where}: ${line.trim()}`)
      }
    }
    expect(rebels).toEqual([])
  })

  test("the shell grants the geometry once, on the cell's child", () => {
    const index = strip(read("index.css"))
    const shell = index
      .split("}")
      .find((rule) => rule.slice(0, rule.indexOf("{")).trim() === '[data-slot="grid-cell"] > [data-component]')
    expect(shell).toBeDefined()
    for (const declaration of [
      "position: relative",
      "display: flex",
      "flex-direction: column",
      "flex: 1",
      "min-width: 0",
      "min-height: 0",
      "background: var(--ade-pane-ground",
      "overflow: hidden",
      "border-radius:",
      "box-shadow:",
    ]) {
      expect(shell).toContain(declaration)
    }
    expect(shell).not.toContain("border:")
  })

  test("focus is the shell's line, with the two opt-outs declared at home", () => {
    const index = strip(read("index.css"))
    expect(index).toContain('[data-slot="grid-cell"] > [data-component][data-focused]')
    expect(index).toContain("var(--ade-pane-focus, 1px solid var(--ade-accent))")
    // The session keeps its ring and design its absence, each by saying so
    // where it lives — never by overriding the shell's line.
    expect(strip(read("grid/pane.css"))).toContain("--ade-pane-focus: none")
    expect(strip(read("design/design.css"))).toContain("--ade-pane-focus: none")
    expect(strip(read("video/video-pane.css"))).toContain("container-type: inline-size")
  })
})
