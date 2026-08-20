import { describe, expect, it } from "bun:test"
import { clampSessionsHeight, calculateHeightResize, parseSessionsHeight } from "./height"

describe("height", () => {
  it("clamps correctly", () => {
    expect(clampSessionsHeight(50)).toBe(100)
    expect(clampSessionsHeight(800)).toBe(600)
    expect(clampSessionsHeight(300)).toBe(300)
  })

  it("calculates resize", () => {
    expect(calculateHeightResize(0, 50, 200)).toBe(250)
  })

  it("parses height", () => {
    expect(parseSessionsHeight("300")).toBe(300)
    expect(parseSessionsHeight("abc")).toBe(200)
  })
})
