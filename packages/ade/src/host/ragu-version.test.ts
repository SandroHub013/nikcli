import { describe, expect, test } from "bun:test"
import { RAGU_VERSION_EVERY_MS, parseRaguVersion } from "./ragu-version"

describe("the ragu version in the top bar", () => {
  test("reads what ragu actually prints on this machine", () => {
    expect(parseRaguVersion({ code: 0, stdout: "ragu v1.384.0\n", stderr: "" })).toBe("v1.384.0")
  })

  test("keeps the number when the wording around it changes", () => {
    expect(parseRaguVersion({ code: 0, stdout: "1.384.0\n", stderr: "" })).toBe("v1.384.0")
    expect(parseRaguVersion({ code: 0, stdout: "ragu, version 2.0.1-beta.3\n", stderr: "" })).toBe("v2.0.1-beta.3")
  })

  test("is not fooled by colour", () => {
    expect(
      parseRaguVersion({ code: 0, stdout: "\u001b[1mragu\u001b[0m \u001b[32mv1.384.0\u001b[0m\n", stderr: "" }),
    ).toBe("v1.384.0")
  })

  test("takes the answer from the error stream when the command still succeeded", () => {
    expect(parseRaguVersion({ code: 0, stdout: "", stderr: "ragu v1.384.0\n" })).toBe("v1.384.0")
  })

  /*
   * Every way of failing ends in the same place. The bar has no room for a
   * message and no business carrying one: a missing ragu is a fact about the
   * machine, not an error in ADE.
   */
  test("shows nothing rather than an error", () => {
    expect(parseRaguVersion(undefined)).toBeUndefined()
    expect(parseRaguVersion(null)).toBeUndefined()
    expect(parseRaguVersion({ code: null, stdout: "", stderr: "ragu non trovato nel PATH" })).toBeUndefined()
    expect(parseRaguVersion({ code: 1, stdout: "v1.384.0", stderr: "" })).toBeUndefined()
    expect(parseRaguVersion({ code: 0, stdout: "usage: ragu [command]", stderr: "" })).toBeUndefined()
  })

  test("is asked again seldom, because it changes only when ragu updates", () => {
    expect(RAGU_VERSION_EVERY_MS).toBe(21_600_000)
  })
})
