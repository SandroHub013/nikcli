import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"

/*
 * Brief ragu-via-servizi-nik, package B (7): the system prompts told the model to answer questions about ragu
 * from the docs on nikcli-ai.dev, Nik's site. No system prompt sends the model there.
 */
const PROMPTS = path.join(import.meta.dir, "../../src/session/prompt")

describe("system prompts", () => {
  test("no prompt points the model at Nik's docs", () => {
    const hits = fs
      .readdirSync(PROMPTS)
      .filter((name) => name.endsWith(".txt"))
      .flatMap((name) =>
        fs
          .readFileSync(path.join(PROMPTS, name), "utf8")
          .split("\n")
          .flatMap((line, i) => (/nikcli-ai\.dev/.test(line) ? [`${name}:${i + 1}`] : [])),
      )
    expect(hits).toEqual([])
  })
})
