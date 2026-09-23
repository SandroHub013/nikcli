import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import postcss, { type Rule } from "postcss"

/*
 * The tile shell — column flex, ground, framelessness, focus line — lives
 * once, on the cell's child in index.css (S67.2).
 *
 * Five panes had each copied the same fifteen lines, and the copies drifted:
 * the video pane kept a hairline border and a focus glow of its own. These
 * assertions fail whichever pane starts rewriting the shell for itself again,
 * however the rule is written, and fail if the shell is taken away — so a pane
 * added tomorrow is laid out by the cell, not by whoever remembers the
 * incantation.
 */

const src = join(import.meta.dir, "..")
const read = (path: string) => readFileSync(join(src, path), "utf8")

/*
 * Which components are pane roots, read from the components, not listed here.
 *
 * A pane root is what the grid focuses: every one sets `data-focused` on the
 * element that carries its `data-component`, and nothing else in ADE does. A
 * name is not the test — a pane called anything at all is found the same way.
 */
function paneRoots(): Set<string> {
  const roots = new Set<string>()
  for (const entry of new Bun.Glob("**/*.tsx").scanSync(src)) {
    if (entry.includes(".test.")) continue
    const lines = readFileSync(join(src, entry), "utf8").split("\n")
    lines.forEach((line, at) => {
      const named = /data-component="([\w-]+)"/.exec(line)
      if (!named) return
      // The rest of the opening tag: the attributes run until a line that only closes it.
      for (let next = at; next < Math.min(lines.length, at + 25); next++) {
        if (lines[next].includes("data-focused")) {
          roots.add(named[1])
          return
        }
        if (next > at && /^\s*\/?>\s*$/.test(lines[next])) return
      }
    })
  }
  return roots
}

/** What the shell owns on a pane root; a pane's own rules may not set any of it. */
const SHELL_OWNED = ["background", "border", "outline", "flex", "display", "position", "overflow", "min-", "height"]
const ownedByShell = (prop: string) => SHELL_OWNED.some((owned) => prop === owned || prop.startsWith(owned.endsWith("-") ? owned : `${owned}-`))

/*
 * The differences a root may draw over the shell, each for a state that is not
 * the shell's and each said here. Only a new line in this list lets a pane
 * set what the shell owns.
 */
const DECLARED: { state: RegExp; props: RegExp; why: string }[] = [
  {
    state: /\[data-dropping\]/,
    props: /^outline(-offset)?$/,
    why: "shots/tray.css: a session that a dragged shot will land on is outlined while the drag is over it",
  },
]

/** The last compound of a selector: what the rule actually styles. */
function lastCompound(selector: string): string {
  let depth = 0
  let start = 0
  for (let i = 0; i < selector.length; i++) {
    const c = selector[i]
    if (c === "[" || c === "(") depth++
    else if (c === "]" || c === ")") depth--
    else if (depth === 0 && (c === " " || c === ">" || c === "+" || c === "~")) start = i + 1
  }
  return selector.slice(start).trim()
}

/** Whether a compound names one of `roots` through `data-component`, with any operator. */
function namesRoot(compound: string, roots: Set<string>): boolean {
  for (const [, op, value] of compound.matchAll(/\[data-component\s*([~|^$*]?=)\s*["']?([^"'\]\s]+)["']?\s*[is]?\]/g)) {
    for (const root of roots) {
      if (
        (op === "=" && root === value) ||
        (op === "~=" && root.split(/\s+/).includes(value)) ||
        (op === "|=" && (root === value || root.startsWith(`${value}-`))) ||
        (op === "^=" && root.startsWith(value)) ||
        (op === "$=" && root.endsWith(value)) ||
        (op === "*=" && root.includes(value))
      )
        return true
    }
  }
  return false
}

/*
 * Every declaration a stylesheet makes on a pane root that belongs to the shell.
 *
 * Parsed, not split on braces: a rule on one line, a comma list, a rule inside
 * `@media` or `@container`, a prefix such as the cell's own — which would beat
 * the shell on specificity — are all the same rule to this.
 *
 * `box-shadow` is how a pane would draw a focus of its own; on a focused root
 * it is allowed only in a rule that also opts out of the shell's line, as the
 * session's ring does.
 */
function shellViolations(css: string, where: string, roots: Set<string>): string[] {
  const found: string[] = []
  postcss.parse(css).walkRules((rule: Rule) => {
    const optsOut = rule.nodes.some((node) => node.type === "decl" && node.prop === "--ade-pane-focus" && node.value.trim() === "none")
    for (const selector of rule.selectors) {
      const compound = lastCompound(selector)
      if (!namesRoot(compound, roots)) continue
      // A pseudo-element is a box of its own inside the root, such as the session's status edge.
      if (/::?(before|after)\b/.test(compound)) continue
      const focused = /\[data-focused|:focus/.test(compound)
      rule.walkDecls((decl) => {
        if (decl.parent !== rule) return
        const prop = decl.prop.toLowerCase()
        if (DECLARED.some((allowed) => allowed.state.test(compound) && allowed.props.test(prop))) return
        if (ownedByShell(prop) || (focused && prop === "box-shadow" && !optsOut)) {
          found.push(`${where}: ${selector} { ${decl.prop}: ${decl.value} }`)
        }
      })
    }
  })
  return found
}

describe("pane roots are found by shape", () => {
  test("every component the grid focuses is one, the plugin's included", () => {
    const roots = paneRoots()
    // Nine kinds today; the plugin mounts as a session. Fewer means the reader broke.
    expect(roots.size).toBeGreaterThanOrEqual(8)
    for (const root of ["session-pane", "design-pane", "video-pane", "file-pane"]) expect(roots.has(root)).toBe(true)
    // A component that takes no focus from the grid is not a pane root.
    expect(roots.has("session-grid")).toBe(false)
  })
})

describe("the pane shell stays in one place", () => {
  const roots = paneRoots()

  test("no stylesheet re-declares the shell on a pane root, however the rule is written", () => {
    const rebels: string[] = []
    for (const entry of new Bun.Glob("**/*.css").scanSync(src)) {
      const file = entry.replace(/\\/g, "/")
      rebels.push(...shellViolations(read(file), file, roots))
    }
    expect(rebels).toEqual([])
  })

  /*
   * The Architect's twelve ways of putting a local rule back (S67-2 review,
   * point 3): the text-shaped test caught two. Each must be caught now.
   */
  const reintroduced: [string, string][] = [
    ["one property per line", '[data-component="video-pane"] {\n  display: flex;\n}'],
    ["focus by border colour", '[data-component="video-pane"][data-focused="true"] {\n  border-color: red;\n}'],
    ["one line, container-type first", '[data-component="video-pane"] { container-type: inline-size; display: flex }'],
    ["background-color", '[data-component="file-pane"] { background-color: red }'],
    ["height", '[data-component="file-pane"] { height: 100% }'],
    ["focus by box-shadow", '[data-component="video-pane"][data-focused] { box-shadow: 0 0 0 1px red }'],
    ["focus by :focus-within", '[data-component="video-pane"]:focus-within { box-shadow: 0 0 0 1px red }'],
    ["the cell's prefix", '[data-slot="grid-cell"] > [data-component="video-pane"] { background: red }'],
    ["a comma list", '.x, [data-component="design-pane"] { overflow: visible }'],
    ["inside @container", '@container (min-width: 1px) { [data-component="video-pane"] { flex: 0 }}'],
    ["inside @media", '@media (min-width: 1px) { [data-component="video-pane"] { min-width: 10px }}'],
    ["another attribute on the root", '[data-component="video-pane"][data-status="x"] { position: static }'],
    ["a suffix match", '[data-component$="-pane"] { outline: 1px solid red }'],
  ]
  for (const [name, css] of reintroduced) {
    test(`a local rule is caught: ${name}`, () => {
      expect(shellViolations(css, "probe.css", roots).length).toBeGreaterThan(0)
    })
  }

  test("what a pane may still say for itself is not caught", () => {
    const allowed = [
      '[data-component="video-pane"] { container-type: inline-size }',
      '[data-component="design-pane"] { --ade-pane-ground: var(--ade-bg) }',
      '[data-component="session-pane"][data-focused] { --ade-pane-focus: none; box-shadow: 0 0 0 1.5px red }',
      '[data-component="video-pane"] > [data-slot="pane-header"] { display: flex; background: red }',
      '[data-component="session-grid"] { display: grid }',
    ]
    for (const css of allowed) expect(shellViolations(css, "probe.css", roots)).toEqual([])
  })

  test("the shell grants the geometry once, on the cell's child", () => {
    const decls = new Map<string, string>()
    postcss.parse(read("index.css")).walkRules((rule) => {
      if (rule.selector.trim() !== '[data-slot="grid-cell"] > [data-component]') return
      rule.walkDecls((decl) => {
        decls.set(decl.prop, decl.value)
      })
    })
    expect(Object.fromEntries(decls)).toMatchObject({
      position: "relative",
      display: "flex",
      "flex-direction": "column",
      flex: "1",
      "min-width": "0",
      "min-height": "0",
      overflow: "hidden",
    })
    expect(decls.get("background")).toStartWith("var(--ade-pane-ground")
    expect(decls.has("border-radius")).toBe(true)
    expect(decls.has("box-shadow")).toBe(true)
    expect(decls.has("border")).toBe(false)
  })

  test("focus is the shell's line, and only the session opts out, at home", () => {
    const index = read("index.css")
    expect(index).toContain('[data-slot="grid-cell"] > [data-component][data-focused]')
    expect(index).toContain("var(--ade-pane-focus, 1px solid var(--ade-accent))")
    // The session keeps its ring by saying so where it lives — never by overriding the shell's line.
    expect(read("grid/pane.css")).toContain("--ade-pane-focus: none")
    const optedOut: string[] = []
    for (const entry of new Bun.Glob("**/*.css").scanSync(src)) {
      const file = entry.replace(/\\/g, "/")
      postcss.parse(read(file)).walkDecls("--ade-pane-focus", (decl) => {
        if (decl.value.trim() === "none") optedOut.push(file)
      })
    }
    expect(optedOut).toEqual(["grid/pane.css"])
    expect(read("video/video-pane.css")).toContain("container-type: inline-size")
  })
})
