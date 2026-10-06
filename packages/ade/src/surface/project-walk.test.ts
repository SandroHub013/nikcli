import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createProjectWalk, type WalkedEntry } from "./project-walk"

const file = (path: string): WalkedEntry => ({ path, kind: "file" })

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((ok, no) => {
    resolve = ok
    reject = no
  })
  return { promise, resolve, reject }
}

describe("the project's file list", () => {
  // Full review 2026-10-06, sessions 18.
  test("a walk of the previous project does not answer for the new one", async () => {
    const a = deferred<WalkedEntry[]>()
    const b = deferred<WalkedEntry[]>()
    const walks: string[] = []
    const search = createProjectWalk({
      walk: (root) => {
        walks.push(root)
        return root === "A" ? a.promise : b.promise
      },
    })
    const forA = search("A")
    const forB = search("B")
    // A finishes first, while B is still being walked.
    a.resolve([file("A/only-in-a.ts")])
    b.resolve([file("B/b.ts")])
    expect(await forB).toEqual([file("B/b.ts")])
    expect(await forA).toEqual([file("A/only-in-a.ts")])
    expect(walks).toEqual(["A", "B"])
    // The list that is kept is B's: asking for B again does not walk and does not see A's files.
    expect(await search("B")).toEqual([file("B/b.ts")])
    expect(walks).toEqual(["A", "B"])
  })

  test("a late walk does not put an older project over the newer list", async () => {
    const a = deferred<WalkedEntry[]>()
    const search = createProjectWalk({
      walk: (root) => (root === "A" ? a.promise : Promise.resolve([file(`${root}/x.ts`)])),
    })
    const forA = search("A")
    expect(await search("B")).toEqual([file("B/x.ts")])
    a.resolve([file("A/late.ts")])
    await forA
    expect(await search("B")).toEqual([file("B/x.ts")])
  })

  test("an old list answers at once, and the fresh one replaces it for the next keystroke", async () => {
    let now = 0
    let round = 0
    const next = deferred<WalkedEntry[]>()
    const search = createProjectWalk({
      now: () => now,
      freshMs: 1000,
      walk: () => (++round === 1 ? Promise.resolve([file("old.ts")]) : next.promise),
    })
    expect(await search("A")).toEqual([file("old.ts")])
    now = 5000
    expect(await search("A")).toEqual([file("old.ts")])
    next.resolve([file("new.ts")])
    await Promise.resolve()
    await Promise.resolve()
    expect(await search("A")).toEqual([file("new.ts")])
  })

  test("a failed refresh behind an old list is not an unhandled rejection, and the next query tries again", async () => {
    let now = 0
    let round = 0
    const search = createProjectWalk({
      now: () => now,
      freshMs: 1000,
      walk: () => (++round === 2 ? Promise.reject(new Error("disco")) : Promise.resolve([file(`r${round}.ts`)])),
    })
    expect(await search("A")).toEqual([file("r1.ts")])
    now = 5000
    expect(await search("A")).toEqual([file("r1.ts")])
    await new Promise((done) => setTimeout(done, 5))
    expect(await search("A")).toEqual([file("r1.ts")])
    await new Promise((done) => setTimeout(done, 5))
    expect(round).toBe(3)
  })

  test("the first walk of a project that fails reaches the one who asked", async () => {
    const search = createProjectWalk({ walk: () => Promise.reject(new Error("niente permessi")) })
    await expect(search("A")).rejects.toThrow("niente permessi")
  })

  test("the workbench uses it, not a walk of its own", () => {
    const source = readFileSync(join(__dirname, "workbench.tsx"), "utf-8")
    expect(source).toContain("createProjectWalk(")
    expect(source).not.toContain("let walkingPromise")
  })
})
