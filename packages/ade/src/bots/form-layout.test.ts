import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/*
 * The bot's settings sit in a column about 280 px wide: model and effort side
 * by side (2fr 1fr) read «openrouter/nvidia/n…» and «predef» (bot-sforzo,
 * A occhio). Held as rules, since the layout is the stylesheet's.
 */
const css = readFileSync(join(import.meta.dir, "bots.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "")
const form = readFileSync(join(import.meta.dir, "bots.tsx"), "utf8")

describe("the bot's settings form", () => {
  test("puts model and effort one under the other", () => {
    const rule = /\[data-slot="bots-form"\]\[data-compact="true"\] \[data-slot="bots-row-fields"\]\s*\{([^}]*)\}/.exec(css)
    expect(rule?.[1]).toContain("grid-template-columns: minmax(0, 1fr)")
  })

  test("is the compact form, and the row holds the model and the effort", () => {
    expect(form).toContain('<form data-slot="bots-form" data-compact="true"')
    const row = form.slice(form.indexOf('<div data-slot="bots-row-fields">'))
    expect(row.indexOf('t("bots.engine.model")')).toBeGreaterThan(-1)
    expect(row.indexOf('t("bots.engine.effort")')).toBeGreaterThan(row.indexOf('t("bots.engine.model")'))
  })
})
