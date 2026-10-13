import { describe, expect, test } from "bun:test"
import { raguverseOpening } from "./open"

const same = (a: string, b: string) => a.toLowerCase().replaceAll("\\", "/") === b.toLowerCase().replaceAll("\\", "/")
const world = (projectRoot?: string) => ({ id: "nv1", mode: "raguverse", ...(projectRoot ? { projectRoot } : {}) })
const session = { id: "s1", mode: "terminal", projectRoot: "C:/a" }

describe("the menu's RaguVerse", () => {
  test("no world yet: one is opened in the active project", () => {
    expect(raguverseOpening([session], "C:/a", same)).toEqual({ kind: "open" })
    expect(raguverseOpening([], undefined, same)).toEqual({ kind: "open" })
  })

  test("the world is in the active project: it is focused, and the user stays where they are", () => {
    expect(raguverseOpening([session, world("C:/a")], "C:/a", same)).toEqual({ kind: "focus", id: "nv1" })
    // The same folder spelled another way is the same project.
    expect(raguverseOpening([world("C:\\A")], "c:/a", same)).toEqual({ kind: "focus", id: "nv1" })
  })

  test("the world is in another project: the user is taken there first, so that something visible happens", () => {
    expect(raguverseOpening([session, world("C:/b")], "C:/a", same)).toEqual({ kind: "focus", id: "nv1", switchTo: "C:/b" })
    expect(raguverseOpening([world("C:/b")], undefined, same)).toEqual({ kind: "focus", id: "nv1", switchTo: "C:/b" })
  })

  test("a world with no project of its own is focused where it is", () => {
    expect(raguverseOpening([world()], "C:/a", same)).toEqual({ kind: "focus", id: "nv1" })
  })
})
