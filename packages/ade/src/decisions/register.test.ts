import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
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
