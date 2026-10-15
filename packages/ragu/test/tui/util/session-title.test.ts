import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { SessionPrimitives } from "@ragu/util/session-primitives"
import { sessionDisplayTitle } from "@tui/util/session-title"

/* Review of the UI, N29: before a title arrives the sidebar read «New session - 2026-10-15T20:48:09.845Z», raw ISO, wrapped. */
describe("sessionDisplayTitle", () => {
  test("a default title becomes the label and the local time, no ISO stamp", () => {
    const at = new Date(2026, 9, 15, 22, 48, 9)
    const title = SessionPrimitives.parentTitlePrefix + at.toISOString()
    expect(sessionDisplayTitle(title)).toBe("New session · 22:48")
  })

  test("a child session keeps its own label", () => {
    const at = new Date(2026, 9, 15, 7, 5, 0)
    expect(sessionDisplayTitle(SessionPrimitives.childTitlePrefix + at.toISOString())).toBe("Child session · 07:05")
  })

  test("a real title is left alone, even one that starts like a default", () => {
    expect(sessionDisplayTitle("Fix the login bug")).toBe("Fix the login bug")
    expect(sessionDisplayTitle("New session - notes")).toBe("New session - notes")
  })

  test("the sidebar and the session list both show it", () => {
    const root = join(import.meta.dir, "../../../../tui/src")
    expect(readFileSync(join(root, "routes/session/sidebar.tsx"), "utf8")).toContain("sessionDisplayTitle(current().title)")
    expect(readFileSync(join(root, "component/dialog-session-list.tsx"), "utf8")).toContain("sessionDisplayTitle(x.title)")
  })
})
