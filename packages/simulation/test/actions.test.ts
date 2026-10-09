import { expect, test } from "bun:test"
import { matches } from "../src/frontend/actions"

test("screen matching is literal and case-sensitive", () => {
  const harness = { screen: () => "ragu [ready].*" }
  expect(matches(harness, "ragu")).toBe(true)
  expect(matches(harness, "[ready].*")).toBe(true)
  expect(matches(harness, "ragu.*ready")).toBe(false)
  expect(matches(harness, "Ragu")).toBe(false)
})
