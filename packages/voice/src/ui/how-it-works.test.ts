import { describe, expect, test } from "bun:test"
import { HowItWorks } from "./how-it-works"

describe("ui/how-it-works", () => {
  test("HowItWorks is exported as a function component", () => {
    expect(typeof HowItWorks).toBe("function")
  })
})
