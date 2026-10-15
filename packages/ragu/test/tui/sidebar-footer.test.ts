import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/*
 * Review of the UI, N13 and N14, the sidebar's foot: «RAGU CODE» (a fourth spelling of the name), and «Ragu includes
 * free models so you can start immediately» — a sentence that rested on a `ragu` gateway provider. models.dev, the
 * catalog the fork reads (Global.Path.modelsDevUrl), has no `ragu` provider (checked 2026-10-16: 230 providers, none
 * named ragu or nikcli), so nothing in the fork offers those free models.
 */
const footer = readFileSync(join(import.meta.dir, "../../../tui/src/feature-plugins/sidebar/footer.tsx"), "utf8")

describe("the sidebar's foot", () => {
  test("names the product «Ragu Code», not «RAGU» + «CODE»", () => {
    expect(footer).toContain("<b>Ragu Code</b>")
    expect(footer).not.toMatch(/<b>RAGU<\/b>|<b>CODE<\/b>/)
  })

  test("promises no free models: the gateway behind that sentence is not the fork's", () => {
    expect(footer).not.toContain("includes free models")
    expect(footer).not.toMatch(/\bRagu\b(?! Code)/)
  })

  test("the getting-started card still says how to connect a provider", () => {
    expect(footer).toContain("Connect provider")
    expect(footer).toContain("/connect")
  })
})
