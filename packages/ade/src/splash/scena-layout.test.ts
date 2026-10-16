import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  REF_WIDTH,
  REF_HEIGHT,
  REF_ASPECT_RATIO,
  computeStageDimensions,
} from "./scene"

describe("splash scene responsive stage layout (Passo 2)", () => {
  const css = readFileSync(join(import.meta.dir, "splash.css"), "utf8")

  test("reference scene dimensions maintain exact 1672x941 resolution and ~1.7768 aspect ratio", () => {
    expect(REF_WIDTH).toBe(1672)
    expect(REF_HEIGHT).toBe(941)
    expect(REF_ASPECT_RATIO).toBeCloseTo(1672 / 941, 5)
  })

  test("stage CSS enforces exact 1672 / 941 aspect ratio and maximum bounds", () => {
    expect(css).toMatch(/aspect-ratio:\s*1672\s*\/\s*941/)
    expect(css).toMatch(/width:\s*min\(94vw,\s*calc\(\(100vh\s*-\s*48px\)\s*\*\s*1672\s*\/\s*941\)\)/)
  })

  test("image-rendering: auto on image for smooth scaling, pixelated on canvas for crisp 8px blocks", () => {
    expect(css).toMatch(/\[data-slot="splash-image"\]\s*\{[^}]*image-rendering:\s*auto;/)
    expect(css).toMatch(/\[data-slot="splash-canvas"\]\s*\{[^}]*image-rendering:\s*pixelated;/)
  })

  test("status message is grouped under stage inside splash-scene-container", () => {
    expect(css).toMatch(/\[data-slot="splash-scene-container"\]\s*\{[^}]*display:\s*flex;/)
    expect(css).toMatch(/\[data-slot="splash-scene-container"\]\s*\{[^}]*flex-direction:\s*column;/)
    expect(css).toMatch(/\[data-slot="splash-scene-container"\]\s*\{[^}]*gap:\s*10px;/)
  })

  test("computeStageDimensions fits cleanly within viewport across 800px to 4K displays", () => {
    const testCases = [
      { name: "800x600 small window", w: 800, h: 600, dpr: 1 },
      { name: "1280x720 HD standard", w: 1280, h: 720, dpr: 1 },
      { name: "1366x768 laptop standard", w: 1366, h: 768, dpr: 1 },
      { name: "1536x826 FHD at 125% DPR", w: 1536, h: 826, dpr: 1.25 },
      { name: "1920x1080 FHD native", w: 1920, h: 1080, dpr: 1 },
      { name: "2560x1440 QHD at 1.25 DPR", w: 2560, h: 1440, dpr: 1.25 },
      { name: "3840x2160 4K at 1.5 DPR", w: 3840, h: 2160, dpr: 1.5 },
      { name: "3840x2160 4K at 2.0 DPR", w: 3840, h: 2160, dpr: 2 },
    ]

    for (const { w, h, dpr } of testCases) {
      const dims = computeStageDimensions(w, h, dpr)

      // Width and height stay strictly within viewport
      expect(dims.width).toBeLessThanOrEqual(w)
      expect(dims.height).toBeLessThanOrEqual(h)

      // Total height with gap (10px) and status (16px) stays within innerHeight
      const totalHeight = dims.height + 10 + 16
      expect(totalHeight).toBeLessThanOrEqual(h)

      // Aspect ratio of the stage is preserved within rounding tolerance
      const ratio = dims.width / dims.height
      expect(ratio).toBeCloseTo(1672 / 941, 1)

      // Scale is positive and non-zero
      expect(dims.scale).toBeGreaterThan(0)
    }
  })
})
