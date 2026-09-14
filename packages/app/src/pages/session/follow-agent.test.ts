import { describe, expect, test } from "bun:test"
import { followTarget, shouldFollow, type FollowPart } from "./follow-agent"

const tool = (name: string, status: string, filePath?: string): FollowPart => ({
  type: "tool",
  tool: name,
  state: { status, input: filePath === undefined ? {} : { filePath } },
})

const text = (): FollowPart => ({ type: "text" })

describe("followTarget", () => {
  test("nothing to follow in an empty or text-only transcript", () => {
    expect(followTarget([])).toBeUndefined()
    expect(followTarget([text(), text()])).toBeUndefined()
  })

  test("follows the file being edited", () => {
    expect(followTarget([tool("edit", "running", "src/a.ts")])).toBe("src/a.ts")
  })

  test("an edit in flight outranks one that already finished", () => {
    expect(
      followTarget([tool("edit", "completed", "src/done.ts"), tool("write", "running", "src/now.ts")]),
    ).toBe("src/now.ts")
    // Order in the transcript must not decide it — the status does.
    expect(
      followTarget([tool("write", "running", "src/now.ts"), tool("edit", "completed", "src/done.ts")]),
    ).toBe("src/now.ts")
  })

  test("falls back to the last finished edit once nothing is in flight", () => {
    expect(followTarget([tool("edit", "completed", "src/a.ts"), tool("edit", "completed", "src/b.ts")])).toBe(
      "src/b.ts",
    )
  })

  test("reading is browsing, not working: it is not followed", () => {
    // An agent reads dozens of files to orient itself. Following each one turns
    // the editor into a slideshow and buries whatever the user was looking at.
    expect(followTarget([tool("read", "running", "src/a.ts")])).toBeUndefined()
    expect(followTarget([tool("edit", "completed", "src/edited.ts"), tool("read", "running", "src/read.ts")])).toBe(
      "src/edited.ts",
    )
  })

  test.each(["grep", "list", "glob", "bash", "webfetch", "task"])("%p names no single file, so it is ignored", (name) => {
    expect(followTarget([tool(name, "running", "src/a.ts")])).toBeUndefined()
  })

  test("a pending or errored edit is not a place to send the user", () => {
    expect(followTarget([tool("edit", "pending", "src/a.ts")])).toBeUndefined()
    expect(followTarget([tool("edit", "error", "src/a.ts")])).toBeUndefined()
  })

  test("a tool part without a file path is skipped rather than followed to nowhere", () => {
    expect(followTarget([tool("edit", "running")])).toBeUndefined()
    expect(followTarget([tool("edit", "running", ""), tool("edit", "completed", "src/a.ts")])).toBe("src/a.ts")
  })

  test("a non-tool part carrying tool-shaped fields is not mistaken for one", () => {
    expect(followTarget([{ type: "text", tool: "edit", state: { status: "running", input: { filePath: "a" } } }])).toBeUndefined()
  })
})

describe("shouldFollow", () => {
  const base = { enabled: true, busy: true, target: "src/a.ts", current: "src/b.ts" }

  test("moves the editor when following is on and the agent is working", () => {
    expect(shouldFollow(base)).toBe(true)
  })

  test("does nothing while switched off", () => {
    expect(shouldFollow({ ...base, enabled: false })).toBe(false)
  })

  test("does not yank the editor once the turn is over", () => {
    // The last edit stays the target after the turn ends; moving then would be
    // the editor taking over rather than following.
    expect(shouldFollow({ ...base, busy: false })).toBe(false)
  })

  test("stays put when the file is already the one on screen", () => {
    expect(shouldFollow({ ...base, current: "src/a.ts" })).toBe(false)
  })

  test("does nothing when there is no target", () => {
    expect(shouldFollow({ ...base, target: undefined })).toBe(false)
  })

  test("opens the first target even with nothing open yet", () => {
    expect(shouldFollow({ ...base, current: undefined })).toBe(true)
  })
})
