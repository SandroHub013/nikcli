import { describe, expect, test } from "bun:test"
import { isTestIdentifier, testBuildMarked } from "./build-identity"

describe("isTestIdentifier", () => {
  test("recognises the test build", () => {
    expect(isTestIdentifier("ai.nikcli.ade.test")).toBe(true)
  })

  test("leaves the official build alone", () => {
    expect(isTestIdentifier("ai.nikcli.ade")).toBe(false)
    expect(isTestIdentifier("ai.nikcli.ade.testing")).toBe(false)
  })
})

describe("testBuildMarked", () => {
  const root = (dataset: Record<string, string>) => ({ dataset }) as unknown as HTMLElement

  test("reads the marks dev.tsx writes before the surface renders", () => {
    expect(testBuildMarked(root({ adeBuild: "test" }))).toBe(true)
    expect(testBuildMarked(root({}))).toBe(false)
    expect(testBuildMarked(undefined)).toBe(false)
  })

  test("an identifier that could not be read counts as a test build", () => {
    expect(testBuildMarked(root({ adeIdentity: "unknown" }))).toBe(true)
  })
})
