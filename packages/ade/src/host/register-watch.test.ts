import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createDecisionsRegister } from "../decisions/register"
import { decisionsPath } from "../decisions/store"
import { createDesignRegister } from "../design/register"
import { designPath } from "../design/store"
import { REGISTERS_WATCH_MS, registersPass } from "./register-watch"
import type { DirEntry } from "./shell"

const root = "/p"

/** A project folder with both registers in `.ade/`, counting what is asked of it. */
function project() {
  const files: Record<string, string> = { [decisionsPath(root)]: "", [designPath(root)]: "" }
  const calls = { readDir: 0, read: 0 }
  const readDir = async (dir: string): Promise<DirEntry[]> => {
    calls.readDir++
    return Object.keys(files)
      .filter((path) => path.startsWith(`${dir}/`))
      .map((path): DirEntry => ({ name: path.slice(dir.length + 1), path, is_dir: false, size: files[path]!.length, modified_ms: 1 }))
  }
  const io = async () => ({
    readTextFile: async (path: string) => {
      calls.read++
      return { text: files[path] ?? "", truncated: false }
    },
    writeTextFile: async () => null,
    readDir,
  })
  return { calls, readDir, io }
}

describe("the two registers are watched in one pass (P1-C2c)", () => {
  test("both files are in .ade/, and a pass lists it once, not once per register", async () => {
    const { calls, readDir, io } = project()
    await createRoot(async (dispose) => {
      const decisions = createDecisionsRegister({ path: () => decisionsPath(root), io })
      const design = createDesignRegister({ path: () => designPath(root), io })
      await decisions.refresh()
      await design.refresh()
      calls.readDir = 0
      calls.read = 0
      await registersPass([decisions, design], readDir)
      dispose()
    })
    expect(calls).toEqual({ readDir: 1, read: 0 })
  })

  test("the pace is not slowed: ade-msg registro promises the button within 3 s", () => {
    expect(REGISTERS_WATCH_MS).toBeLessThanOrEqual(2500)
  })
})
