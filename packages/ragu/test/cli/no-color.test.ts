import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { CliOutput } from "effect/unstable/cli"
import { colorEnabled } from "@/cli/color"

/*
 * Review of the CLI, P1 7: effect coloured the help unless `NO_COLOR` was exactly "1". The standard is any non-empty
 * value, so `NO_COLOR=true` (and `NO_COLOR=yes`) still printed escape codes into logs and pipes.
 */
describe("the CLI's own output is coloured only where colour is wanted", () => {
  test("any non-empty NO_COLOR turns it off, whatever it says", () => {
    for (const value of ["1", "true", "yes", "0", "anything"]) expect(colorEnabled({ NO_COLOR: value }, true)).toBe(false)
  })

  test("an empty NO_COLOR is no NO_COLOR", () => {
    expect(colorEnabled({ NO_COLOR: "" }, true)).toBe(true)
    expect(colorEnabled({}, true)).toBe(true)
  })

  test("not a terminal, or a dumb one, is not coloured either", () => {
    expect(colorEnabled({}, false)).toBe(false)
    expect(colorEnabled({ TERM: "dumb" }, true)).toBe(false)
    expect(colorEnabled({ TERM: "xterm-256color" }, true)).toBe(true)
  })

  test("the formatter built from it prints no escape codes with NO_COLOR=true, and does with a terminal", () => {
    const plain = CliOutput.defaultFormatter({ colors: colorEnabled({ NO_COLOR: "true" }, true) })
    expect(plain.formatVersion("ragu", "1.0.0")).not.toContain("\x1b[")
    const colored = CliOutput.defaultFormatter({ colors: colorEnabled({}, true) })
    expect(colored.formatVersion("ragu", "1.0.0")).toContain("\x1b[")
  })

  test("the entrypoint renders with that formatter", () => {
    const source = readFileSync(join(import.meta.dir, "../../src/cli/main-effect.ts"), "utf8")
    expect(source).toContain("Effect.provide(outputLayer())")
  })
})
