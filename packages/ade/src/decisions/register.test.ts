import { describe, expect, test } from "bun:test"
import { createEffect, createRoot, createSignal } from "solid-js"
import type { DirEntry } from "../host/shell"
import { createDecisionsRegister } from "./register"
import type { DecisionsIo } from "./store"

const PATH = "/p/.ade/decisions.jsonl"

const entry = (modified: number): DirEntry => ({
  name: "decisions.jsonl",
  path: PATH,
  is_dir: false,
  size: 10,
  modified_ms: modified,
})

/** A register file that cannot be read, whose modification time the test moves. */
function unreadable() {
  const file = { modified: 1, readable: false, reads: 0 }
  const io: DecisionsIo & { readDir: (path: string) => Promise<DirEntry[]> } = {
    readTextFile: async () => {
      file.reads += 1
      if (!file.readable) throw new Error("registro illeggibile")
      return { text: "", truncated: false }
    },
    writeTextFile: async () => null,
    readDir: async () => [entry(file.modified)],
  }
  return { io, file }
}

describe("the register when its file cannot be read", () => {
  // Full review 2026-10-06, ui 9: the failed read left `loadedPath` behind, so every tick read the file again.
  test("a failed read is not repeated on every tick, only when the file changes", async () => {
    const { io, file } = unreadable()
    await createRoot(async (dispose) => {
      const register = createDecisionsRegister({ path: () => PATH, io: async () => io })

      await register.tick()
      expect(file.reads).toBe(1)
      expect(register.error()).toBe("registro illeggibile")

      await register.tick()
      await register.tick()
      await register.tick()
      expect(file.reads).toBe(1)

      // The file changes: one more attempt, and the register recovers when it can be read.
      file.modified = 2
      file.readable = true
      await register.tick()
      expect(file.reads).toBe(2)
      expect(register.error()).toBeUndefined()
      expect(register.loaded()).toBeDefined()

      await register.tick()
      expect(file.reads).toBe(2)
      dispose()
    })
  })

  test("an explicit refresh still reads, and a changed file is read again by the next tick", async () => {
    const { io, file } = unreadable()
    await createRoot(async (dispose) => {
      const register = createDecisionsRegister({ path: () => PATH, io: async () => io })
      await register.tick()
      await register.refresh()
      expect(file.reads).toBe(2)
      file.modified = 5
      await register.tick()
      expect(file.reads).toBe(3)
      dispose()
    })
  })
})

describe("register path and state atomicity on project switch (D1)", () => {
  test("never emits mixed pairs of (loadedPath, state keys) during project switch A -> B", async () => {
    const PATH_A = "/p1/.ade/decisions.jsonl"
    const PATH_B = "/p2/.ade/decisions.jsonl"
    const jsonA = JSON.stringify({ type: "aperta", k: "D-A1", at: "2026-10-07T00:00:00.000Z", by: "T", title: "A", context: "C", options: [{ label: "1" }] })
    const jsonB = JSON.stringify({ type: "aperta", k: "D-B1", at: "2026-10-07T00:00:00.000Z", by: "T", title: "B", context: "C", options: [{ label: "1" }] })
    const files = new Map([
      [PATH_A, jsonA],
      [PATH_B, jsonB],
    ])
    const io: DecisionsIo & { readDir: (path: string) => Promise<DirEntry[]> } = {
      readTextFile: async (path: string) => {
        const text = files.get(path)
        if (text === undefined) throw new Error("not found")
        return { text, truncated: false }
      },
      writeTextFile: async () => null,
      readDir: async () => [],
    }

    await createRoot(async (dispose) => {
      const [currentPath, setCurrentPath] = createSignal<string | undefined>(PATH_A)
      const register = createDecisionsRegister({ path: currentPath, io: async () => io })

      const seen: [string | undefined, string[]][] = []
      createEffect(() => {
        const p = register.loadedPath()
        const keys = (register.state()?.decisions ?? []).map((d) => d.k)
        seen.push([p, keys])
      })

      // Load project A
      await register.refresh()
      expect(seen).toEqual([
        [undefined, []],
        [PATH_A, ["D-A1"]],
      ])

      // Project switches to B, then refreshes B
      setCurrentPath(PATH_B)
      await register.refresh()

      // The effect must never observe mixed pairs (e.g. PATH_B with keys of A, or PATH_A without keys)
      const afterFirstLoad = seen.filter(([p]) => p !== undefined)
      expect(afterFirstLoad.length).toBeGreaterThan(0)
      for (const [p, keys] of afterFirstLoad) {
        if (p === PATH_A) expect(keys).toEqual(["D-A1"])
        if (p === PATH_B) expect(keys).toEqual(["D-B1"])
      }
      expect(seen[seen.length - 1]).toEqual([PATH_B, ["D-B1"]])

      dispose()
    })
  })
})

