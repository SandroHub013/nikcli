import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"

/*
 * Brief ragu-via-servizi-nik, package A closed after the merge: A removed the `ragu-inference` provider from ragu, but
 * the LLM package still shipped its own, pointed at inference.nikcli-ai.dev and exported from @ragu/llm. Nobody imports
 * it but its own test; it goes.
 */
const LLM = path.join(import.meta.dir, "../../../llm")
const read = (file: string) => fs.readFileSync(path.join(LLM, file), "utf8")

describe("the LLM package has no provider for Nik's gateway", () => {
  test("the provider, its export and its entry point are gone", () => {
    expect(fs.existsSync(path.join(LLM, "src/providers/ragu-inference.ts"))).toBe(false)
    expect(read("src/providers/index.ts")).not.toContain("ragu-inference")
    expect(read("package.json")).not.toContain("ragu-inference")
  })
})
