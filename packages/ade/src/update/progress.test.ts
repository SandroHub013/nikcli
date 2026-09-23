import { describe, expect, test } from "bun:test"
import { formatMb, parseUpdateProgress, progressPercent } from "./progress"

describe("update progress", () => {
  test("megabytes follow the language's decimal mark", () => {
    expect(formatMb(3_845_000, "it")).toBe("3,8")
    expect(formatMb(3_845_000, "en")).toBe("3.8")
    expect(formatMb(9_100_000, "en")).toBe("9.1")
  })

  test("the percentage needs a known size, and installing is the end", () => {
    expect(progressPercent(undefined)).toBeUndefined()
    expect(progressPercent({ phase: "download", downloaded: 10, total: null })).toBeUndefined()
    expect(progressPercent({ phase: "download", downloaded: 42, total: 100 })).toBe(42)
    expect(progressPercent({ phase: "download", downloaded: 250, total: 100 })).toBe(100)
    expect(progressPercent({ phase: "install" })).toBe(100)
  })

  test("only the two shapes the Rust side sends are read", () => {
    expect(parseUpdateProgress({ phase: "download", downloaded: 5, total: 9 })).toEqual({ phase: "download", downloaded: 5, total: 9 })
    expect(parseUpdateProgress({ phase: "download", downloaded: 5 })).toEqual({ phase: "download", downloaded: 5, total: null })
    expect(parseUpdateProgress({ phase: "install" })).toEqual({ phase: "install" })
    expect(parseUpdateProgress({ phase: "download" })).toBeUndefined()
    expect(parseUpdateProgress({ phase: "download", downloaded: -1, total: 9 })).toBeUndefined()
    expect(parseUpdateProgress({ phase: "download", downloaded: 5, total: 0 })).toEqual({ phase: "download", downloaded: 5, total: null })
    expect(parseUpdateProgress("install")).toBeUndefined()
    expect(parseUpdateProgress(null)).toBeUndefined()
  })
})
