import { describe, expect, test } from "bun:test"
import type { Host } from "../host"
import { writeBot, type CreateBotInput } from "./store"

const input = {
  name: "news",
  scope: "project",
  description: "d",
  persona: "Sei news.",
  mode: "primary",
  home: "C:/p/.nikcli",
  base: "C:/p",
} as unknown as CreateBotInput & { home: string; base: string; mode: "primary" }

describe("writeBot and a check that fails (review of F7d, O1)", () => {
  test("a rejected existence check is said, and nothing is written over what may be there", async () => {
    const written: string[] = []
    const host = {
      exists: async () => {
        throw new Error("unità non pronta")
      },
      writeTextFile: async (path: string) => {
        written.push(path)
        return null
      },
    } as unknown as Host
    const result = await writeBot(input, host)
    expect(result).toEqual({ ok: false, problem: "unità non pronta" })
    expect(written).toEqual([])
  })

  test("a file that is there is refused, and a free name is written", async () => {
    const written: string[] = []
    const make = (there: boolean) =>
      ({
        exists: async () => there,
        writeTextFile: async (path: string) => {
          written.push(path)
          return null
        },
      }) as unknown as Host
    const refused = await writeBot(input, make(true))
    expect(refused.ok).toBe(false)
    expect(written).toEqual([])
    const done = await writeBot(input, make(false))
    expect(done.ok).toBe(true)
    expect(written).toHaveLength(1)
  })
})
