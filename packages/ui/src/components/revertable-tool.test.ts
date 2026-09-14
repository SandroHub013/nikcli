import { describe, expect, test } from "bun:test"
import { canRevertToolPart } from "./revertable-tool"

const ok = { tool: "edit", status: "completed", hasEarlierPartInMessage: true }

describe("canRevertToolPart", () => {
  test.each(["edit", "write", "apply_patch", "patch", "multiedit"])("%p touched the working tree", (tool) => {
    expect(canRevertToolPart({ ...ok, tool })).toBe(true)
  })

  test.each(["read", "grep", "glob", "list", "bash", "webfetch", "task", "todowrite"])(
    "%p changed nothing to undo",
    (tool) => {
      expect(canRevertToolPart({ ...ok, tool })).toBe(false)
    },
  )

  test.each(["running", "pending", "error"])("a call that is %p has no settled effect", (status) => {
    expect(canRevertToolPart({ ...ok, status })).toBe(false)
  })

  test("the first action of a turn is not offered, because reverting it deletes the prompt", () => {
    // The server drops the partID when nothing precedes the part in its message,
    // and then anchors the revert to the user's message and removes it.
    expect(canRevertToolPart({ ...ok, hasEarlierPartInMessage: false })).toBe(false)
  })

  test("every gate has to pass, not just one", () => {
    expect(canRevertToolPart({ tool: "read", status: "completed", hasEarlierPartInMessage: true })).toBe(false)
    expect(canRevertToolPart({ tool: "edit", status: "running", hasEarlierPartInMessage: true })).toBe(false)
    expect(canRevertToolPart({ tool: "edit", status: "completed", hasEarlierPartInMessage: false })).toBe(false)
  })
})
