import { describe, expect, test } from "bun:test"
import { NIKCLI_VERSION_EVERY_MS, parseNikcliVersion } from "./nikcli-version"

describe("the nikcli version in the top bar", () => {
  test("reads what nikcli actually prints on this machine", () => {
    expect(parseNikcliVersion({ code: 0, stdout: "nikcli v1.384.0\n", stderr: "" })).toBe("v1.384.0")
  })

  test("keeps the number when the wording around it changes", () => {
    expect(parseNikcliVersion({ code: 0, stdout: "1.384.0\n", stderr: "" })).toBe("v1.384.0")
    expect(parseNikcliVersion({ code: 0, stdout: "nikcli, version 2.0.1-beta.3\n", stderr: "" })).toBe("v2.0.1-beta.3")
  })

  test("is not fooled by colour", () => {
    expect(parseNikcliVersion({ code: 0, stdout: "\u001b[1mnikcli\u001b[0m \u001b[32mv1.384.0\u001b[0m\n", stderr: "" })).toBe("v1.384.0")
  })

  test("takes the answer from the error stream when the command still succeeded", () => {
    expect(parseNikcliVersion({ code: 0, stdout: "", stderr: "nikcli v1.384.0\n" })).toBe("v1.384.0")
  })

  /*
   * Every way of failing ends in the same place. The bar has no room for a
   * message and no business carrying one: a missing nikcli is a fact about the
   * machine, not an error in ADE.
   */
  test("shows nothing rather than an error", () => {
    expect(parseNikcliVersion(undefined)).toBeUndefined()
    expect(parseNikcliVersion(null)).toBeUndefined()
    expect(parseNikcliVersion({ code: null, stdout: "", stderr: "nikcli non trovato nel PATH" })).toBeUndefined()
    expect(parseNikcliVersion({ code: 1, stdout: "v1.384.0", stderr: "" })).toBeUndefined()
    expect(parseNikcliVersion({ code: 0, stdout: "usage: nikcli [command]", stderr: "" })).toBeUndefined()
  })

  test("is asked again seldom, because it changes only when nikcli updates", () => {
    expect(NIKCLI_VERSION_EVERY_MS).toBe(21_600_000)
  })
})
