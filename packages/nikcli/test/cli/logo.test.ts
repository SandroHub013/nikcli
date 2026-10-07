import { describe, expect, it } from "bun:test"
import { BANNER_MIN_COLUMNS, BANNER_WIDTH, PLAIN_LOGO, logo, truecolor } from "@/cli/logo"

const plain = (raw: string) => raw.replace(/\x1b\[[0-9;]*m/g, "")

describe("the Ragu Code logo", () => {
  it("draws the pixel banner in half blocks on a wide 24-bit terminal", () => {
    const out = logo("  ", { truecolor: true, columns: 120 })
    const lines = out.split("\n")
    expect(lines).toHaveLength(15)
    expect(out).toContain("\x1b[38;2;223;74;43m")
    expect(plain(out)).toMatch(/[▀▄█]/)
    for (const line of lines) expect(plain(line).length).toBeLessThanOrEqual(2 + BANNER_WIDTH)
    expect(plain(out)).not.toContain("nikomatt69")
    expect(plain(out)).not.toContain("NIKCLI")
  })

  it("writes the name in plain text without 24-bit colour", () => {
    expect(logo("  ", { truecolor: false, columns: 120 })).toBe(`  ${PLAIN_LOGO}`)
  })

  it("draws no banner below 60 columns, or when the pad pushes it past the edge", () => {
    expect(BANNER_MIN_COLUMNS).toBe(60)
    expect(logo("", { truecolor: true, columns: 59 })).toBe(PLAIN_LOGO)
    expect(logo("  ", { truecolor: true, columns: 60 })).toBe(`  ${PLAIN_LOGO}`)
    expect(logo("", { truecolor: true, columns: 60 })).toContain("\x1b[38;2;")
  })

  it("draws no banner when stderr is not a terminal", () => {
    expect(logo(undefined, { truecolor: true, columns: undefined })).toBe(PLAIN_LOGO)
  })

  it("takes 24-bit colour from COLORTERM, Windows Terminal and known terminals, never under NO_COLOR", () => {
    expect(truecolor({ COLORTERM: "truecolor" })).toBe(true)
    expect(truecolor({ COLORTERM: "24bit" })).toBe(true)
    expect(truecolor({ WT_SESSION: "x" })).toBe(true)
    expect(truecolor({ TERM_PROGRAM: "vscode" })).toBe(true)
    expect(truecolor({ TERM: "xterm-kitty" })).toBe(true)
    expect(truecolor({ TERM: "xterm-256color" })).toBe(false)
    expect(truecolor({})).toBe(false)
    expect(truecolor({ COLORTERM: "truecolor", NO_COLOR: "1" })).toBe(false)
  })
})
