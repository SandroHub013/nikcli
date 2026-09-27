import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

/*
 * notifiche-design, step 5: the browser pane is a browser and nothing else.
 * A proposal's variants live on its one sheet; the pane's Design mode, its
 * «Aggiungi alla nota» and the variant-in-a-pane path are gone («senza cose
 * nostre»).
 */
const src = join(import.meta.dir, "..")
const read = (path: string) => readFileSync(join(src, path), "utf8")

describe("the browser pane has no Design mode", () => {
  test("lint: the Design mode's files stay deleted", () => {
    for (const path of ["browser/design-mode.ts", "browser/design-url.ts", "design/open-variant.ts"]) {
      expect(existsSync(join(src, path))).toBe(false)
    }
  })

  test("lint: the pane, the renderer and the pane state do not name the Design mode", () => {
    const pane = read("browser/browser-pane.tsx")
    expect(pane).not.toContain("props.design")
    expect(pane).not.toContain("designActions")
    expect(read("surface/pane-renderer.tsx")).not.toContain("designActions")
    expect(read("surface/state.ts")).not.toContain("browserDesign")
  })

  test("lint: the pane's frame takes its one sandbox, BROWSE_SANDBOX", () => {
    expect(read("browser/browser-pane.tsx")).toContain("sandbox={BROWSE_SANDBOX}")
  })

  test("the frame always has its own origin", async () => {
    const { BROWSE_SANDBOX } = await import("./sandbox")
    expect(BROWSE_SANDBOX.split(" ")).toContain("allow-same-origin")
  })

  test("lint: the hub names no openVariant and no addNoteLine", () => {
    const hub = read("design/hub.ts")
    expect(hub).not.toContain("openVariant")
    expect(hub).not.toContain("addNoteLine")
  })
})
