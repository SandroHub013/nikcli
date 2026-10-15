import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { productVersion, shortVersion } from "@tui/util/product-name"

/*
 * Review of the UI, N13: the product had four spellings in the TUI («Ragu», «Ragu Code», «RAGUCODE» in the sidebar's
 * foot, «Ragu vlocal» in the status). In text it is «Ragu Code»; `ragu` is the command.
 */
const tui = (file: string) => readFileSync(join(import.meta.dir, "../../../../tui/src", file), "utf8")

describe("the product's name and version", () => {
  test("a release is «Ragu Code v1.431.0»; a development build says «local», without a «v» in front", () => {
    expect(productVersion("1.431.0+fork.13")).toBe("Ragu Code v1.431.0+fork.13")
    expect(productVersion("local")).toBe("Ragu Code local")
    expect(shortVersion("local")).toBe("local")
    expect(shortVersion("1.2.3")).toBe("v1.2.3")
  })

  test("the status uses them", () => {
    expect(tui("component/dialog-status.tsx")).toContain("productVersion(VERSION)")
  })

  test("no visible string says «Ragu» alone in the places the review found", () => {
    const places = ["routes/session/permission.tsx", "component/dialog-onboarding.tsx", "component/dialog-status.tsx"]
    for (const file of places) {
      const bare = tui(file).match(/\bRagu\b(?! Code| Mobile)(?![A-Za-z_(])/g) ?? []
      expect({ file, bare }).toEqual({ file, bare: [] })
    }
  })
})
