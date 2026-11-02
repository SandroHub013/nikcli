import { describe, expect, test } from "bun:test"
import { RAGU_VERSION_EVERY_MS, parseRaguVersion, raguSingleEsc } from "./ragu-version"

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

/*
 * Audit 2026-11-02, SES-5: from 0.2.11 a single Esc acts (it sends what was queued, or stops the turn), so the second
 * Esc of the old double-Esc aborted the turn the first one had just started.
 */
describe("which ragu acts on a single Esc", () => {
  test("0.2.11 and later do, in the 0.x line", () => {
    expect(raguSingleEsc("v0.2.11")).toBe(true)
    expect(raguSingleEsc("v0.2.14")).toBe(true)
    expect(raguSingleEsc("v0.3.0")).toBe(true)
    expect(raguSingleEsc("v0.2.11-rc.1")).toBe(true)
  })

  test("older ones, the 1.x line of the old build, and an unknown version keep the double Esc", () => {
    expect(raguSingleEsc("v0.2.10")).toBe(false)
    expect(raguSingleEsc("v0.1.99")).toBe(false)
    expect(raguSingleEsc("v1.384.0")).toBe(false)
    expect(raguSingleEsc(undefined)).toBe(false)
    expect(raguSingleEsc("not a version")).toBe(false)
  })
})
