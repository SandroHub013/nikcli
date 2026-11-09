import { describe, expect, test } from "bun:test"
import { createPasteModes } from "./paste-mode"

/*
 * SES-14: the workbench read each chunk of a pane's output alone for `ESC [ ? 2004 h/l`, so a switch cut between two
 * chunks was missed and a paste went in the wrong way.
 */
const ESC = "\u001b"

describe("bracketed paste, read across chunks (SES-14)", () => {
  test("a switch cut in two chunks is read once they are together", () => {
    const modes = createPasteModes()
    modes.note("p", `${ESC}[?20`)
    expect(modes.on("p")).toBe(false)
    modes.note("p", "04h")
    expect(modes.on("p")).toBe(true)
  })

  test("and the off switch the same way", () => {
    const modes = createPasteModes()
    modes.note("p", `${ESC}[?2004h`)
    modes.note("p", `${ESC}[?2004`)
    expect(modes.on("p")).toBe(true)
    modes.note("p", "l")
    expect(modes.on("p")).toBe(false)
  })

  test("a whole off switch turns it off", () => {
    const modes = createPasteModes()
    modes.note("p", `${ESC}[?2004h`)
    modes.note("p", `${ESC}[?2004l`)
    expect(modes.on("p")).toBe(false)
  })

  test("2004 among other modes in one switch counts", () => {
    const modes = createPasteModes()
    modes.note("p", `${ESC}[?1049;2004h`)
    expect(modes.on("p")).toBe(true)
  })

  test("another mode alone does not touch it", () => {
    const modes = createPasteModes()
    modes.note("p", `${ESC}[?2004h`)
    modes.note("p", `${ESC}[?1049l`)
    expect(modes.on("p")).toBe(true)
  })

  test("the last switch in a chunk wins", () => {
    const modes = createPasteModes()
    modes.note("p", `${ESC}[?2004l text ${ESC}[?2004h`)
    expect(modes.on("p")).toBe(true)
    modes.note("p", `${ESC}[?2004h text ${ESC}[?2004l`)
    expect(modes.on("p")).toBe(false)
  })

  test("a switch already seen in the kept tail does not undo a later one", () => {
    const modes = createPasteModes()
    modes.note("p", `${ESC}[?2004h`)
    modes.note("p", `${ESC}[?2004l`)
    // The tail still holds the whole off switch; a chunk that adds nothing must not bring the old on back.
    modes.note("p", "x")
    expect(modes.on("p")).toBe(false)
  })

  test("a long list of modes cut late is still read (the tail holds more than a short switch)", () => {
    const modes = createPasteModes()
    const whole = `${ESC}[?1000;1006;2004h`
    modes.note("p", whole.slice(0, 17))
    modes.note("p", whole.slice(17))
    expect(modes.on("p")).toBe(true)
  })

  test("each pane has its own mode, and forget clears one", () => {
    const modes = createPasteModes()
    modes.note("a", `${ESC}[?2004h`)
    expect(modes.on("a")).toBe(true)
    expect(modes.on("b")).toBe(false)
    modes.forget("a")
    expect(modes.on("a")).toBe(false)
    // And its tail: the half of a switch left behind is not joined to a new pane's output.
    modes.note("a", `${ESC}[?20`)
    modes.forget("a")
    modes.note("a", "04h")
    expect(modes.on("a")).toBe(false)
  })
})

describe("the workbench uses it (SES-14)", () => {
  // The workbench cannot be loaded under bun: read from the source. Booleans, so a failure does not print the file.
  const source = require("node:fs").readFileSync(require("node:path").join(import.meta.dir, "..", "surface", "workbench.tsx"), "utf8") as string

  test("one createPasteModes, read with `.on`, fed with `.note` by both pane kinds and cleared with `.forget` three times", () => {
    expect(source.includes("const pasteModes = createPasteModes()")).toBe(true)
    expect(source.includes("pasteModes.on(paneId)")).toBe(true)
    expect(source.split("pasteModes.note(paneId, chunk)").length - 1).toBe(2)
    expect(source.split("pasteModes.forget(").length - 1).toBe(3)
    expect(source.includes("noteBracketedPaste")).toBe(false)
    expect(source.includes("bracketedPaste.")).toBe(false)
  })
})
