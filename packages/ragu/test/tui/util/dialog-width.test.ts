import { describe, expect, test } from "bun:test"
import { dialogWidth, fitOptionText } from "@tui/util/dialog-width"

/* Review of the UI, N30: «Workspace panel (sessions · changes · graph · gi» was cut by the layout, with no «…». */
describe("fitOptionText", () => {
  test("a short title and description pass through whole", () => {
    expect(fitOptionText("Models", "Pick a model", 60)).toEqual({ title: "Models", description: "Pick a model" })
  })

  test("a long description is cut with «…» to the room the title leaves", () => {
    const out = fitOptionText("Workspace panel", "(sessions · changes · graph · git · files · terminal)", 40)
    expect(out.title).toBe("Workspace panel")
    expect(out.description!.endsWith("…")).toBe(true)
    expect(out.title.length + 1 + out.description!.length).toBeLessThanOrEqual(40)
  })

  test("a long title is cut with «…» and the description gives way", () => {
    const out = fitOptionText("A".repeat(80), "more", 30)
    expect(out.title.endsWith("…")).toBe(true)
    expect(out.title.length).toBeLessThanOrEqual(30)
    expect(out.description).toBeUndefined()
  })

  test("no description, none made up", () => {
    expect(fitOptionText("Models", undefined, 60)).toEqual({ title: "Models" })
  })
})

describe("dialogWidth", () => {
  test("is the panel's width for each size, capped by the terminal", () => {
    expect(dialogWidth("medium", 200)).toBe(60)
    expect(dialogWidth("large", 200)).toBe(88)
    expect(dialogWidth("xlarge", 200)).toBe(120)
    expect(dialogWidth("small", 200)).toBe(42)
    expect(dialogWidth("medium", 50)).toBe(46)
    expect(dialogWidth("full", 100)).toBe(96)
  })
})
