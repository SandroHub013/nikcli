import { describe, expect, test } from "bun:test"
import { DEFAULT_BINDINGS, resolveDefaultBindings } from "./bindings"
import { findConflicts } from "./keymap"

describe("DEFAULT_BINDINGS", () => {
  test("every entry has a non-empty command id", () => {
    for (const entry of DEFAULT_BINDINGS) {
      expect(entry.commandId.length).toBeGreaterThan(0)
    }
  })

  test("every entry has a non-empty chord string", () => {
    for (const entry of DEFAULT_BINDINGS) {
      expect(entry.chord.length).toBeGreaterThan(0)
    }
  })

  test("no conflicts on mac", () => {
    const resolved = resolveDefaultBindings("mac")
    const conflicts = findConflicts(resolved)
    expect(conflicts).toEqual([])
  })

  test("no conflicts on other platforms", () => {
    const resolved = resolveDefaultBindings("other")
    const conflicts = findConflicts(resolved)
    expect(conflicts).toEqual([])
  })

  test("resolves to the expected number of bindings", () => {
    const resolved = resolveDefaultBindings("other")
    expect(resolved.length).toBe(DEFAULT_BINDINGS.length)
  })

  test("includes essential bindings", () => {
    const ids = DEFAULT_BINDINGS.map(b => b.commandId)
    expect(ids).toContain("palette.open")
    expect(ids).toContain("session.new")
    expect(ids).toContain("pane.close")
    expect(ids).toContain("prompt.send")
  })

  test("includes all four directional focus bindings", () => {
    const ids = DEFAULT_BINDINGS.map(b => b.commandId)
    expect(ids).toContain("focus.up")
    expect(ids).toContain("focus.down")
    expect(ids).toContain("focus.left")
    expect(ids).toContain("focus.right")
  })
})
