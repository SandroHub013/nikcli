import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { en } from "../i18n/en"
import { it } from "../i18n/it"
import { EVENTS_MAX_BYTES } from "./recording"
import { workbenchSource } from "../test-support/workbench-source"

/*
 * MOD2-4: the export read the pointer log with the host's default limit of 1 MB. A take longer than a few minutes has
 * more than that, and a truncated log was used without a word: zoom and clicks stopped where the file was cut. The
 * limit is raised to what a take can hold (the export itself stops near 21 minutes), and when the file is still cut the
 * user is told.
 */
describe("the events file is read whole, or the cut is said (MOD2-4)", () => {
  test("the limit is 64 MB", () => {
    expect(EVENTS_MAX_BYTES).toBe(64 * 1024 * 1024)
  })

  // The workbench cannot be loaded under bun: read from the source. Booleans, so a failure does not print the file.
  const source = workbenchSource()
  const at = source.indexOf("const exportLastTake = async () => {")
  const body = source.slice(at, source.indexOf("exportPromo({", at))

  test("the export reads it with that limit", () => {
    expect(at).toBeGreaterThan(-1)
    expect(body.includes("readTextFile(eventsPathFor(video), EVENTS_MAX_BYTES)")).toBe(true)
  })

  test("and says so, as information, when the file came back cut", () => {
    expect(body.includes("file?.truncated")).toBe(true)
    expect(body.includes('report(t("record.export.eventsCut"), "info")')).toBe(true)
  })

  test("the note exists in both languages", () => {
    expect(it["record.export.eventsCut"]).toBe("Il registro del puntatore supera 64 MB: zoom e clic coprono solo la prima parte.")
    expect(en["record.export.eventsCut"]).toBe("The pointer log is over 64 MB: zoom and clicks cover only the first part.")
  })
})
