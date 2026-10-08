import { describe, expect, it } from "bun:test"
import { Layer } from "effect"
import { runtimeFor } from "@/effect/runtime"

describe("runtimeFor", () => {
  it("reuses runtimes within a test home and isolates different homes", () => {
    const previousHome = process.env.RAGU_TEST_HOME
    const previousDatabase = process.env.RAGU_DB
    const layer = Layer.empty

    try {
      process.env.RAGU_TEST_HOME = "/tmp/ragu-runtime-a"
      process.env.RAGU_DB = "/tmp/ragu-runtime-a/nikcli.db"
      const first = runtimeFor(layer)
      expect(runtimeFor(layer)).toBe(first)

      process.env.RAGU_TEST_HOME = "/tmp/ragu-runtime-b"
      process.env.RAGU_DB = "/tmp/ragu-runtime-b/nikcli.db"
      expect(runtimeFor(layer)).not.toBe(first)
    } finally {
      if (previousHome === undefined) delete process.env.RAGU_TEST_HOME
      else process.env.RAGU_TEST_HOME = previousHome
      if (previousDatabase === undefined) delete process.env.RAGU_DB
      else process.env.RAGU_DB = previousDatabase
    }
  })
})
