import { describe, expect, test } from "bun:test"
import { framePluginOpening } from "./open"

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

describe("opening a plugin's panel", () => {
  test("none open: open one", () => {
    expect(framePluginOpening([], "hello", "C:/a", same)).toEqual({ kind: "open" })
    expect(framePluginOpening([{ id: "p1", framePlugin: { id: "other" } }], "hello", "C:/a", same)).toEqual({ kind: "open" })
  })

  test("one open in the active project: focus it, and stay", () => {
    const panes = [{ id: "p1", framePlugin: { id: "hello" }, projectRoot: "C:/a" }]
    expect(framePluginOpening(panes, "hello", "c:/A", same)).toEqual({ kind: "focus", id: "p1" })
  })

  test("one open in another project: take the user there first", () => {
    const panes = [{ id: "p1", framePlugin: { id: "hello" }, projectRoot: "C:/b" }]
    expect(framePluginOpening(panes, "hello", "C:/a", same)).toEqual({ kind: "focus", id: "p1", switchTo: "C:/b" })
    expect(framePluginOpening(panes, "hello", undefined, same)).toEqual({ kind: "focus", id: "p1", switchTo: "C:/b" })
  })

  test("a session, a browser or another plugin's panel is not this plugin's panel", () => {
    const panes = [{ id: "s1" }, { id: "b1" }, { id: "p2", framePlugin: { id: "other" } }]
    expect(framePluginOpening(panes, "hello", "C:/a", same)).toEqual({ kind: "open" })
  })
})
