import { describe, expect, test } from "bun:test"
import { parseUtterance } from "../intent/parse"
import { confirmationAnswer } from "./session"

/**
 * F7e, D3: the spoken yes in English. Until now only the Italian words confirmed («no» worked because it is the same word in both
 * languages), so an English «yes» to «Concedo il permesso, va bene?» was `unclear`.
 */
describe("the spoken yes in English", () => {
  test("«yes», «allow» and «approve» confirm", () => {
    for (const text of ["yes", "Yes!", "allow", "approve", "yes, allow", "okay"]) {
      expect([text, confirmationAnswer(text)]).toEqual([text, "yes"])
    }
  })

  test("a yes with a but is not a yes, and the words for «always» never confirm", () => {
    expect(confirmationAnswer("yes but wait")).toBe("no")
    for (const text of ["yes always", "allow always", "yes for the session", "sì sempre", "allow all"]) {
      expect([text, confirmationAnswer(text)]).toEqual([text, "unclear"])
    }
  })

  test("«allow permission» and «approve request» are the permission.allow command, still confirmed first", () => {
    for (const text of ["allow permission", "approve request", "allow action"]) {
      const parsed = parseUtterance(text)
      expect([text, parsed.outcome, parsed.intent?.intent]).toEqual([text, "matched", "permission.allow"])
    }
  })

  test("none of the phrases of permission.allow means «always»", async () => {
    const { VOCABULARY } = await import("../intent/vocabulary")
    const spec = VOCABULARY.find((v) => v.intent === "permission.allow")!
    for (const phrase of spec.phrases) expect(phrase).not.toMatch(/always|sempre|session/i)
  })
})
