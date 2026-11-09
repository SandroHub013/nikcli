import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createChangeWriter } from "./change-writer"
import { workbenchSource } from "../test-support/workbench-source"

/*
 * WB-13: the held mail's fingerprint was remembered before the write was tried, so a write that failed was never tried
 * again for the same mail.
 */
describe("a change writer (WB-13)", () => {
  test("after a failure, the same fingerprint is written again", () => {
    const writer = createChangeWriter(() => {})
    let attempts = 0
    expect(writer.save("a", () => (attempts++, false))).toBe(false)
    expect(writer.save("a", () => (attempts++, true))).toBe(true)
    expect(attempts).toBe(2)
  })

  test("after a success, the same fingerprint is skipped", () => {
    const writer = createChangeWriter(() => {})
    let attempts = 0
    writer.save("a", () => (attempts++, true))
    expect(writer.save("a", () => (attempts++, true))).toBe(true)
    expect(attempts).toBe(1)
  })

  test("another fingerprint is written", () => {
    const writer = createChangeWriter(() => {})
    let attempts = 0
    writer.save("a", () => (attempts++, true))
    writer.save("b", () => (attempts++, true))
    expect(attempts).toBe(2)
  })

  test("onFail runs once for two failures in a row, and again after a success followed by a failure", () => {
    let told = 0
    const writer = createChangeWriter(() => told++)
    writer.save("a", () => false)
    writer.save("a", () => false)
    expect(told).toBe(1)
    writer.save("a", () => true)
    writer.save("b", () => false)
    expect(told).toBe(2)
  })

  test("a fingerprint that was never written is never skipped, even an empty one", () => {
    const writer = createChangeWriter(() => {})
    let attempts = 0
    writer.save("", () => (attempts++, true))
    expect(attempts).toBe(1)
  })
})

describe("the workbench saves its held mail through one (WB-13)", () => {
  // The workbench cannot be loaded under bun: read from the source. Booleans, so a failure does not print the file.
  const source = workbenchSource()

  test("writeStored says whether it wrote, and persistMail goes through the writer", () => {
    expect(source.includes("const mailWriter = createChangeWriter(() => report(t(\"workspace.saveFailed\")))")).toBe(true)
    expect(source.includes("mailWriter.save(now, () => writeStored(QUEUE_KEY, queue) && saveSuspendedMail())")).toBe(true)
    expect(source.includes("savedMail")).toBe(false)
  })
})
