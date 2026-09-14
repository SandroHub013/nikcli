import { describe, expect, test } from "bun:test"
import { commitSubject, SUBJECT_LIMIT } from "./commit-subject"

describe("commitSubject", () => {
  test("uses the session title as it stands when it already fits", () => {
    expect(commitSubject("Add the pending message queue")).toBe("Add the pending message queue")
  })

  test("has nothing to offer without a title", () => {
    expect(commitSubject(undefined)).toBe("")
    expect(commitSubject("")).toBe("")
    expect(commitSubject("   ")).toBe("")
  })

  test("takes only the first line", () => {
    expect(commitSubject("Fix the login bug\n\nwith some detail")).toBe("Fix the login bug")
  })

  test("collapses the whitespace a generated title may carry", () => {
    expect(commitSubject("  Fix   the    bug  ")).toBe("Fix the bug")
  })

  test("drops trailing punctuation, which git convention leaves off", () => {
    expect(commitSubject("Fix the login bug.")).toBe("Fix the login bug")
    expect(commitSubject("Fix the login bug…")).toBe("Fix the login bug")
    expect(commitSubject("Fix the login bug...")).toBe("Fix the login bug")
  })

  test("keeps punctuation that is not at the end", () => {
    expect(commitSubject("Fix v1.2 parsing")).toBe("Fix v1.2 parsing")
  })

  test("keeps a question mark, which carries meaning", () => {
    expect(commitSubject("Why does the parser drop blank lines?")).toBe("Why does the parser drop blank lines?")
  })

  test("cuts on a word boundary rather than mid-word", () => {
    const long = "Refactor the entire authentication subsystem and its surrounding integration tests"
    const subject = commitSubject(long)
    expect(subject.length).toBeLessThanOrEqual(SUBJECT_LIMIT)
    expect(long.startsWith(subject)).toBe(true)
    expect(subject.endsWith(" ")).toBe(false)
    // The cut fell between words, so the last word is whole.
    expect(long[subject.length]).toBe(" ")
  })

  test("a space too early in the cut is not used as the boundary", () => {
    // The threshold exists so a title like "fix <100 chars of one word>" yields
    // the full 72-character cut rather than the word "fix". Nothing exercised it:
    // every other long input has its last space past the halfway mark.
    const title = `fix ${"x".repeat(100)}`
    expect(commitSubject(title)).toHaveLength(SUBJECT_LIMIT)
    expect(commitSubject(title).startsWith("fix x")).toBe(true)
  })

  test("a space just past halfway is used", () => {
    const head = "a".repeat(Math.floor(SUBJECT_LIMIT / 2) + 1)
    expect(commitSubject(`${head} ${"b".repeat(80)}`)).toBe(head)
  })

  test("truncates a single very long word rather than returning almost nothing", () => {
    const word = "x".repeat(200)
    expect(commitSubject(word)).toHaveLength(SUBJECT_LIMIT)
  })

  test("never exceeds the limit, whatever the shape of the title", () => {
    for (const title of ["y".repeat(300), `${"word ".repeat(60)}`, `${"a".repeat(71)} bb`]) {
      expect(commitSubject(title).length).toBeLessThanOrEqual(SUBJECT_LIMIT)
    }
  })

  test("a title exactly at the limit is left alone", () => {
    const exact = "z".repeat(SUBJECT_LIMIT)
    expect(commitSubject(exact)).toBe(exact)
  })
})
