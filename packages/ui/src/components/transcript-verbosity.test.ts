import { describe, expect, test } from "bun:test"
import {
  isTranscriptVerbosity,
  nextVerbosity,
  shouldHideReasoning,
  shouldHideToolCalls,
  TRANSCRIPT_VERBOSITY,
  type TranscriptVerbosity,
} from "./transcript-verbosity"

describe("isTranscriptVerbosity", () => {
  test.each(["compact", "normal", "verbose"])("accepts %p", (value) => {
    expect(isTranscriptVerbosity(value)).toBe(true)
  })

  test.each(["", "quiet", "NORMAL", null, undefined, 1, {}])("rejects %p from persisted state", (value) => {
    expect(isTranscriptVerbosity(value)).toBe(false)
  })
})

describe("nextVerbosity", () => {
  test("cycles towards more detail, then wraps", () => {
    expect(nextVerbosity("compact")).toBe("normal")
    expect(nextVerbosity("normal")).toBe("verbose")
    expect(nextVerbosity("verbose")).toBe("compact")
  })

  test("returns to the starting point after one full cycle", () => {
    for (const start of TRANSCRIPT_VERBOSITY) {
      let value: TranscriptVerbosity = start
      for (let i = 0; i < TRANSCRIPT_VERBOSITY.length; i++) value = nextVerbosity(value)
      expect(value).toBe(start)
    }
  })

  test("every level is reachable from every other", () => {
    for (const start of TRANSCRIPT_VERBOSITY) {
      const seen = new Set<TranscriptVerbosity>()
      let value: TranscriptVerbosity = start
      for (let i = 0; i < TRANSCRIPT_VERBOSITY.length; i++) {
        seen.add(value)
        value = nextVerbosity(value)
      }
      expect(seen.size).toBe(TRANSCRIPT_VERBOSITY.length)
    }
  })
})

describe("shouldHideReasoning", () => {
  test("verbose always keeps it", () => {
    expect(shouldHideReasoning({ verbosity: "verbose", working: true })).toBe(false)
    expect(shouldHideReasoning({ verbosity: "verbose", working: false })).toBe(false)
  })

  test("compact never keeps it, even mid-turn", () => {
    expect(shouldHideReasoning({ verbosity: "compact", working: true })).toBe(true)
    expect(shouldHideReasoning({ verbosity: "compact", working: false })).toBe(true)
  })

  test("normal keeps it only while the turn is running, as before", () => {
    expect(shouldHideReasoning({ verbosity: "normal", working: true })).toBe(false)
    expect(shouldHideReasoning({ verbosity: "normal", working: false })).toBe(true)
  })
})

describe("shouldHideToolCalls", () => {
  test("only compact drops them", () => {
    expect(shouldHideToolCalls("compact")).toBe(true)
    expect(shouldHideToolCalls("normal")).toBe(false)
    expect(shouldHideToolCalls("verbose")).toBe(false)
  })
})

describe("as a whole", () => {
  test("detail never decreases going compact to normal to verbose", () => {
    const hiddenCount = (verbosity: TranscriptVerbosity, working: boolean) =>
      Number(shouldHideReasoning({ verbosity, working })) + Number(shouldHideToolCalls(verbosity))

    for (const working of [true, false]) {
      expect(hiddenCount("compact", working)).toBeGreaterThanOrEqual(hiddenCount("normal", working))
      expect(hiddenCount("normal", working)).toBeGreaterThanOrEqual(hiddenCount("verbose", working))
    }
  })
})
