import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

/*
 * Every kind of pane can be expanded and closed, and the two buttons show.
 *
 * Read from the sources rather than rendered: the panes need a host, a
 * workbench and a WebGL or video element each, and what broke in 0.6.1 was a
 * stylesheet, which happy-dom does not cascade. The video and editor panes had
 * the buttons, wired, but invisible: `pane-actions` starts at opacity 0 and
 * only some panes had the rule that reveals it.
 */

const src = join(import.meta.dir, "..")
const read = (path: string) => readFileSync(join(src, path), "utf8")
const renderer = read("surface/pane-renderer.tsx")

/** The file a component imported by the renderer lives in, through a barrel if there is one. */
function componentFile(component: string): string {
  const from = new RegExp(`import \\{[^}]*\\b${component}\\b[^}]*\\} from "\\.\\./([^"]+)"`).exec(renderer)?.[1]
  if (!from) throw new Error(`${component} is not imported by the renderer`)
  if (existsSync(join(src, `${from}.tsx`))) return `${from}.tsx`
  const barrel = read(`${from}/index.ts`)
  const named = new RegExp(`export \\{[^}]*\\b${component}\\b[^}]*\\} from "\\./([^"]+)"`).exec(barrel)?.[1]
  const star = [...barrel.matchAll(/export \* from "\.\/([^"]+)"/g)]
    .map((match) => match[1]!)
    .find((file) => existsSync(join(src, from, `${file}.tsx`)) && read(`${from}/${file}.tsx`).includes(`export function ${component}(`))
  const inner = named ?? star
  if (!inner) throw new Error(`${component} is not exported by ${from}/index.ts`)
  return `${from}/${inner}.tsx`
}

/** Each `const xPane = () => (<Component …/>)` of the renderer, with its props. */
const panes = [...renderer.matchAll(/const (\w+Pane) = \(\) => \(\s*<(\w+)([\s\S]*?)\n    \)\n/g)].map((match) => ({
  name: match[1]!,
  component: match[2]!,
  props: match[3]!,
}))

describe("pane chrome", () => {
  test("the renderer's panes are all found", () => {
    expect(panes.map((pane) => pane.name).sort()).toEqual(
      ["browserPane", "decisionsPane", "designPane", "filePane", "modelPane", "pluginPane", "sessionPane", "simulatorPane", "videoPane"].sort(),
    )
  })

  for (const pane of panes) {
    test(`${pane.name} is given expand and close, and has buttons for both`, () => {
      expect(pane.props).toMatch(/\bonClose=\{/)
      expect(pane.props).toMatch(/\bonExpand=\{/)
      const source = read(componentFile(pane.component))
      // Its own buttons, or the shared ones given both handlers.
      const shared = /<PaneActions onExpand=\{\(\) => props\.onExpand\?\.\(\)\} onClose=\{\(\) => props\.onClose\?\.\(\)\}/.test(source)
      if (!shared) {
        expect(source).toMatch(/onClick=\{\(\) => props\.onExpand\?\.\(\)\}/)
        expect(source).toMatch(/onClick=\{\(\) => props\.onClose\?\.\(\)\}/)
      }
    })
  }

  test("the video pane has the session's header and buttons (0.6.1)", () => {
    for (const file of ["grid/pane.tsx", "video/video-pane.tsx"]) {
      const source = read(file)
      expect(`${file}: ${source.includes('<header class="pill hA" data-slot="pane-header">')}`).toBe(`${file}: true`)
      expect(`${file}: ${source.includes("<PaneActions onExpand=")}`).toBe(`${file}: true`)
    }
    const actions = read("grid/pane-actions.tsx")
    expect(actions).toContain('class="act" data-slot="pane-action"')
    expect(actions).toContain('data-slot="pane-actions"')
  })

  test("every pane that uses the shared actions is revealed by the shared rule", () => {
    const css = read("grid/pane.css")
    expect(css).toContain('[data-slot="grid-cell"]:hover > [data-component] [data-slot="pane-actions"]')
    expect(css).toContain('[data-slot="grid-cell"][data-focused] > [data-component] [data-slot="pane-actions"]')
    for (const pane of panes) {
      const file = componentFile(pane.component)
      const source = read(file)
      if (!source.includes('data-slot="pane-actions"')) continue
      const component = /data-component="([^"]+)"/.exec(source)?.[1]
      expect(`${file}: ${component}`).toMatch(/: [\w-]+-pane$/)
    }
  })

  test("a pane that is a size container grows into its cell", () => {
    // A size container stops taking its width from its content: without
    // `flex: 1` the video pane was 1.6px wide in ADE Test. The shell on the
    // cell's child grants it to every pane now (S67.2), so the invariant
    // lives with the geometry it protects instead of in each container's
    // own copy of the rule.
    const index = read("index.css").replace(/\/\*[\s\S]*?\*\//g, "")
    const shell = index
      .split("}")
      .find((rule) => rule.slice(0, rule.indexOf("{")).trim() === '[data-slot="grid-cell"] > [data-component]')
    expect(shell).toBeDefined()
    expect(shell).toContain("flex: 1")
  })

  test("no stylesheet hides the shared actions again", () => {
    const hidden: string[] = []
    for (const entry of new Bun.Glob("**/*.css").scanSync(src)) {
      const file = entry.replace(/\\/g, "/")
      if (file === "grid/pane.css") continue
      for (const rule of readFileSync(join(src, file), "utf8").split("}")) {
        if (rule.includes('[data-slot="pane-actions"]') && /opacity:\s*0\b/.test(rule)) {
          hidden.push(`${file}: ${rule.trim().split("\n")[0]}`)
        }
      }
    }
    expect(hidden).toEqual([])
  })

  test("a header floats only where its own pane lifts it, never by its class (S67.3)", () => {
    /*
     * `.pill.hA` used to carry `position: absolute`, so every pane that took
     * the pill got it floating and the video pane undid that with a rule keyed
     * on the class — a name it does not own, which a refactor of the pill
     * would have broken in silence. The class is the look; the lift is a
     * decision each pane makes in its own sheet, on the header slot.
     */
    const css = read("grid/pane.css").replace(/\/\*[\s\S]*?\*\//g, "")
    const pill = css.split("}").find((rule) => /^\s*\.pill\.hA\s*\{/.test(rule))
    expect(pill).toBeDefined()
    expect(pill).not.toMatch(/position\s*:/)
    expect(pill).not.toMatch(/z-index\s*:/)
    const lifted = css.split("}").filter((rule) => /position\s*:\s*absolute/.test(rule) && /pane-header/.test(rule))
    expect(lifted.map((rule) => rule.slice(0, rule.indexOf("{")).trim())).toEqual(['[data-component="session-pane"] > [data-slot="pane-header"]'])
    for (const entry of new Bun.Glob("**/*.css").scanSync(src)) {
      const file = entry.replace(/\\/g, "/")
      if (file === "grid/pane.css") continue
      const sheet = readFileSync(join(src, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "")
      expect(`${file}: ${/\.hA\b/.test(sheet)}`).toBe(`${file}: false`)
    }
  })

  test("the pill's clearance follows the header, never a list of body slots (S67.1)", () => {
    /*
     * The 42px under the floating pill used to be granted to three bodies by
     * name — terminal, transcript, plugin — so the fourth view of the pane
     * started underneath the pill and nothing said so until the pane was open.
     * The clearance belongs to whoever follows the lifted header: a selector
     * that names bodies again fails here, and a body added tomorrow must not
     * need an edit in this rule to be born covered.
     */
    const clearances: string[] = []
    for (const entry of new Bun.Glob("**/*.css").scanSync(src)) {
      const file = entry.replace(/\\/g, "/")
      const css = readFileSync(join(src, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "")
      for (const rule of css.split("}")) {
        if (!/padding-top:\s*42px/.test(rule)) continue
        clearances.push(`${file}: ${rule.slice(0, rule.indexOf("{")).trim()}`)
      }
    }
    expect(clearances).toHaveLength(1)
    const [clearance] = clearances
    expect(clearance!.startsWith("grid/pane.css: ")).toBe(true)
    expect(clearance).toContain('[data-component="session-pane"] > [data-slot="pane-header"] ~ *')
    expect(clearance).toContain(':not([data-slot="pane-dock"])')
    for (const body of ["pane-terminal", "pane-transcript", "pane-plugin"]) {
      expect(clearance).not.toContain(body)
    }
  })
})
