import { describe, expect, test } from "bun:test"
import { createEffect, createRoot, createSignal } from "solid-js"
import type { DirEntry } from "../host/shell"
import { createDesignRegister } from "./register"
import type { DesignIo } from "./store"

describe("design register path and state atomicity on project switch (D1)", () => {
  test("never emits mixed pairs of (loadedPath, state keys) during project switch A -> B", async () => {
    const PATH_A = "/p1/.ade/design.jsonl"
    const PATH_B = "/p2/.ade/design.jsonl"
    const jsonA = JSON.stringify({
      type: "aperta",
      k: "DS-A1",
      at: "2026-10-07T00:00:00.000Z",
      by: "T",
      title: "Design A",
      question: "Q?",
      context: "C",
      variants: [{ name: "1", description: "d", preview: "" }],
    })
    const jsonB = JSON.stringify({
      type: "aperta",
      k: "DS-B1",
      at: "2026-10-07T00:00:00.000Z",
      by: "T",
      title: "Design B",
      question: "Q?",
      context: "C",
      variants: [{ name: "1", description: "d", preview: "" }],
    })
    const files = new Map([
      [PATH_A, jsonA],
      [PATH_B, jsonB],
    ])
    const io: DesignIo & { readDir?: (path: string) => Promise<DirEntry[]> } = {
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
      const register = createDesignRegister({ path: currentPath, io: async () => io })

      const seen: [string | undefined, string[]][] = []
      createEffect(() => {
        const p = register.loadedPath()
        const keys = (register.state()?.proposals ?? []).map((prop) => prop.k)
        seen.push([p, keys])
      })

      // Load project A
      await register.refresh()
      expect(seen).toEqual([
        [undefined, []],
        [PATH_A, ["DS-A1"]],
      ])

      // Switch to project B and refresh B
      setCurrentPath(PATH_B)
      await register.refresh()

      // The effect must never observe mixed pairs (e.g. PATH_B with keys of A, or PATH_A without keys)
      const afterFirstLoad = seen.filter(([p]) => p !== undefined)
      expect(afterFirstLoad.length).toBeGreaterThan(0)
      for (const [p, keys] of afterFirstLoad) {
        if (p === PATH_A) expect(keys).toEqual(["DS-A1"])
        if (p === PATH_B) expect(keys).toEqual(["DS-B1"])
      }
      expect(seen).toEqual([
        [undefined, []],
        [PATH_A, ["DS-A1"]],
        [PATH_B, ["DS-B1"]],
      ])

      dispose()
    })
  })
})
