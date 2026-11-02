import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { compileSolidJsx } from "../test-support/solid-jsx"

compileSolidJsx()
const { createRoot } = await import("solid-js")
const { render } = await import("solid-js/web")
const { EmptyIcon, EMPTY_ICONS } = await import("./empty-icon")

/*
 * DS-17 (2026-11-02 audit), the user's choice B «Icona per vista»: an empty
 * view carries a neutral line icon of its own, and the pixel pot is for the
 * no-project screen only (it was a stock folder). The shared EmptyState
 * component is another brief; this is the icon and its place, as a small
 * `EmptyIcon` in src/ui/.
 */
const src = join(import.meta.dir, "..")
const read = (file: string) => readFileSync(join(src, file), "utf8")

describe("EmptyIcon (DS-17)", () => {
  test("draws a line icon on a 24 grid with the 1.5 stroke, for decoration only", () => {
    const container = document.createElement("div")
    document.body.appendChild(container)
    let dispose!: () => void
    createRoot((d) => {
      dispose = d
      render(() => EmptyIcon({ name: "chat" }), container)
    })
    try {
      const svg = container.querySelector("svg")!
      expect(svg.getAttribute("viewBox")).toBe("0 0 24 24")
      expect(svg.getAttribute("aria-hidden")).toBe("true")
      expect(svg.getAttribute("stroke")).toBe("currentColor")
      expect(svg.getAttribute("stroke-width")).toBe("1.5")
      expect(svg.getAttribute("fill")).toBe("none")
      // The approved mock (DS-audit-vuoti/B): the icon sits in a soft circle, not bare.
      expect(container.querySelector('[data-slot="empty-icon"] > svg')).toBe(svg)
    } finally {
      dispose()
      container.remove()
    }
  })

  test("one icon per view, all different", () => {
    const names = Object.keys(EMPTY_ICONS).sort()
    expect(names).toEqual(["agent", "chat", "design", "decisions", "model"].sort())
    expect(new Set(Object.values(EMPTY_ICONS)).size).toBe(names.length)
  })

  test("the sheet carries the colour and the size, not the markup", () => {
    const css = read("ui/empty-icon.css")
    expect(css).toMatch(/\[data-slot="empty-icon"\]\s*\{[^}]*color:\s*var\(--ade-text-weak\)/)
    expect(css).toMatch(/\[data-slot="empty-icon"\]\s*\{[^}]*width:\s*44px/)
    expect(css).toMatch(/\[data-slot="empty-icon"\]\s*\{[^}]*height:\s*44px/)
    expect(css).toMatch(/\[data-slot="empty-icon"\]\s*\{[^}]*border-radius:\s*var\(--ade-radius-full\)/)
    expect(css).toMatch(/\[data-slot="empty-icon"\]\s*\{[^}]*background:\s*var\(--ade-active\)/)
    expect(css).toMatch(/\[data-slot="empty-icon"\] svg\s*\{[^}]*width:\s*22px/)
  })
})

describe("where the icons are (DS-17)", () => {
  test("the main empty views take theirs", () => {
    expect(read("agent/agent-console.tsx")).toMatch(/<EmptyIcon name="agent"/)
    expect(read("chat/chat.tsx")).toMatch(/<EmptyIcon name="chat"/)
    expect(read("model3d/model-pane.tsx")).toMatch(/<EmptyIcon name="model"/)
    expect(read("decisions/decisions-pane.tsx")).toMatch(/<EmptyIcon name="decisions"/)
    expect(read("design/design-pane.tsx")).toMatch(/<EmptyIcon name="design"/)
  })

  test("the pixel pot is on the no-project screen, and the stock folder is gone", () => {
    const empty = read("surface/empty-project.tsx")
    expect(empty).toMatch(/<RaguPotMark/)
    expect(empty).not.toMatch(/M3 6\.5A1\.5/)
  })

  test("the pot is 40px with no tile, as in the mock", () => {
    expect(read("surface/empty-project.tsx")).toMatch(/<RaguPotMark size=\{40\}/)
    const rule = /\[data-slot="empty-mark"\]\s*\{([^}]*)\}/.exec(read("dev.css"))?.[1] ?? ""
    expect(rule).toMatch(/width:\s*40px/)
    for (const tile of ["background", "border", "border-radius"]) expect(rule).not.toContain(`${tile}:`)
  })

  test("the pot is not on any other empty view", () => {
    for (const file of ["agent/agent-console.tsx", "chat/chat.tsx", "model3d/model-pane.tsx", "decisions/decisions-pane.tsx", "design/design-pane.tsx"]) {
      expect(read(file)).not.toContain("RaguPotMark")
    }
  })
})
