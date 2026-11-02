import { describe, expect, test } from "bun:test"
import { projectOfLink } from "./project-of"

describe("the project a chat message runs in", () => {
  const on = { bot: "b", platform: "telegram", project: "C:/p", enabled: true }

  test("a link that is on gives its project", () => {
    expect(projectOfLink([on], "b", "telegram")).toBe("C:/p")
  })

  test("a link that is switched off gives none, though it keeps its project: no turn starts for a late message (BOT-2)", () => {
    expect(projectOfLink([{ ...on, enabled: false }], "b", "telegram")).toBeUndefined()
  })

  test("a link with no word on being on still gives its project, and a missing one or another platform gives none", () => {
    const { enabled: _enabled, ...unsaid } = on
    expect(projectOfLink([unsaid], "b", "telegram")).toBe("C:/p")
    expect(projectOfLink([on], "b", "slack")).toBeUndefined()
    expect(projectOfLink([on], "x", "telegram")).toBeUndefined()
    expect(projectOfLink([{ ...on, project: null }], "b", "telegram")).toBeUndefined()
  })
})
