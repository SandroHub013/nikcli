import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { formatCap, formatClock, formatCount, formatUsd } from "./format"

/*
 * D32: numbers, money and hours as the language of ADE writes them. The comma and the dollar after the number in
 * Italian, the dot and the dollar before it in English; the hour in the language's own style, not the system's.
 */
describe("the numbers follow the language", () => {
  test("a count: 950, 1,2k, 12k, 3,4M in Italian, with the dot in English", () => {
    expect(formatCount(950, "it")).toBe("950")
    expect(formatCount(1234, "it")).toBe("1,2k")
    expect(formatCount(12345, "it")).toBe("12k")
    expect(formatCount(3_400_000, "it")).toBe("3,4M")
    expect(formatCount(1234, "en")).toBe("1.2k")
    expect(formatCount(3_400_000, "en")).toBe("3.4M")
  })

  test("dollars of a real charge: three places under a cent, two otherwise", () => {
    expect(formatUsd(0.009, "it")).toBe("0,009 $")
    expect(formatUsd(0.01, "it")).toBe("0,01 $")
    expect(formatUsd(1.2, "it")).toBe("1,20 $")
    expect(formatUsd(0.009, "en")).toBe("$0.009")
    expect(formatUsd(1.2, "en")).toBe("$1.20")
  })

  test("a cap has two places in both", () => {
    expect(formatCap(0.1, "it")).toBe("0,10 $")
    expect(formatCap(0.3, "en")).toBe("$0.30")
  })

  test("the hour is the language's own", () => {
    const at = new Date(2026, 9, 16, 14, 5).getTime()
    expect(formatClock(at, "it")).toBe("14:05")
    expect(formatClock(at, "en")).toMatch(/^0?2:05\s?PM$/)
  })

  test("they follow the language of ADE when none is given", () => {
    // The default locale in the tests is Italian.
    expect(formatCount(1234)).toBe("1,2k")
    expect(formatCap(0.1)).toBe("0,10 $")
  })
})

describe("nothing in the bot's screens writes them by hand any more", () => {
  const read = (file: string) => readFileSync(join(import.meta.dir, file), "utf8")

  test("lint: the page, the room and the gateway panel use the formats", () => {
    const page = read("bots.tsx")
    expect(page).toContain('import { formatCount } from "./format"')
    expect(page).not.toContain("toFixed(n >= 10_000 ? 0 : 1)")
    const room = read("room-panel.tsx")
    expect(room).toContain("formatCap(")
    expect(room).not.toContain(".toFixed(2)")
    const gateway = read("gateway/panel.tsx")
    expect(gateway).toContain("formatClock(")
    expect(gateway).not.toContain("toLocaleTimeString([]")
  })

  test("lint: the date of an old message puts the month where the language does", () => {
    expect(read("talk.ts")).toContain('t("bots.when.date"')
  })
})
