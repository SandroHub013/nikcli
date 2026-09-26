import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/* G10, live: the manifest wrapped in the panel's font, and a JSON wrapped mid-key is hard to check before pasting. */

const css = readFileSync(join(import.meta.dir, "..", "bots.css"), "utf8")
const panel = readFileSync(join(import.meta.dir, "panel.tsx"), "utf8")

describe("the Slack manifest in the panel", () => {
  test("reads as code, one line per line", () => {
    expect(panel).toContain('data-role="manifest"')
    const rule = /\[data-component="bot-gateway"\] \[data-role="manifest"\]\s*\{([^}]*)\}/.exec(css)
    expect(rule).not.toBeNull()
    expect(rule![1]).toContain("font-family: var(--ade-mono)")
    expect(rule![1]).toContain("white-space: pre")
  })
})
