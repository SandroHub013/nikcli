import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { Keybind } from "@tui/util/keybind"

/* Review of the UI, N23: the session list's footer printed «pin/unpin <leader> p» where everything else says «ctrl+x p». */
describe("Keybind.display", () => {
  const leader = Keybind.parse("ctrl+x")[0]!

  test("spells out the leader", () => {
    expect(Keybind.display(Keybind.parse("<leader>p")[0], leader)).toBe("ctrl+x p")
    expect(Keybind.display(Keybind.parse("<leader>r")[0], leader)).toBe("ctrl+x r")
  })

  test("leaves a binding without the leader as it is", () => {
    expect(Keybind.display(Keybind.parse("ctrl+g")[0], leader)).toBe("ctrl+g")
    expect(Keybind.display(undefined, leader)).toBe("")
  })

  test("with no leader configured the text is the plain one", () => {
    expect(Keybind.display(Keybind.parse("<leader>p")[0], undefined)).toBe("<leader> p")
  })
})

describe("the select dialog's footer", () => {
  test("prints its bindings through the keybind context, not the raw string", () => {
    const source = readFileSync(join(import.meta.dir, "../../../../tui/src/ui/dialog-select.tsx"), "utf8")
    expect(source).toContain("keybind.printInfo(item.keybind)")
    expect(source).not.toContain("Keybind.toString(item.keybind)")
  })
})
