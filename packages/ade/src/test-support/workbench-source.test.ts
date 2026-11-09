import { describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { WORKBENCH_PARTS, workbenchSource } from "./workbench-source"

/*
 * Step 0 of the split of workbench.tsx (WB2-4): one way to read the workbench in a test. Moving code out of the file
 * must not turn a pin red, and it would if tests read `workbench.tsx` by name: they read the workbench and its parts
 * through `workbenchSource()`, and this refuses a new test that reads the file directly.
 */
const SRC = join(import.meta.dir, "..")
const VOICE_SRC = join(import.meta.dir, "..", "..", "..", "voice", "src")

describe("the workbench's source for tests", () => {
  test("every part exists, and the source is the parts joined, LF only", () => {
    for (const part of WORKBENCH_PARTS) expect(existsSync(join(SRC, part))).toBe(true)
    const source = workbenchSource()
    expect(source.length).toBeGreaterThan(100_000)
    expect(source.includes("\r")).toBe(false)
    expect(source.includes("export function Workbench")).toBe(true)
  })

  test("the first part is the workbench itself", () => {
    expect(WORKBENCH_PARTS[0]).toBe("surface/workbench.tsx")
  })
})

/** Tests that name the file without reading its text: a fixture of the owners table, and the import-graph walk. */
const NAMES_ONLY = new Set(["owners.test.ts", "startup-graph.test.ts", "workbench-source.test.ts"])

function tests(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === "node_modules") return []
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return tests(path)
    return /\.test\.tsx?$/.test(name) && !NAMES_ONLY.has(name) ? [path] : []
  })
}

describe("no test reads workbench.tsx directly", () => {
  // A quoted path that ends in `workbench.tsx`, outside a comment: whatever reads it (readFileSync, new URL, Bun.file,
  // a local `read(...)`) is reading the file by name.
  const NAMES_THE_FILE = /["'`][^"'`\n]*workbench\.tsx["'`]/

  test("the tests of ade and of the voice package go through workbenchSource()", () => {
    const offenders = [...tests(SRC), ...tests(VOICE_SRC)].flatMap((path) =>
      readFileSync(path, "utf8")
        .split("\n")
        .flatMap((line, index) =>
          NAMES_THE_FILE.test(line) && !/^\s*(\/\/|\*|\/\*)/.test(line) ? [`${path.slice(SRC.length + 1)}:${index + 1}`] : [],
        ),
    )
    expect(offenders).toEqual([])
    // Cold, it reads every test file of both packages for the first time (Defender scans each): 5.9 s once, 289 ms after.
  }, 30_000)

  test("the rule sees what it forbids, and not a comment or a word that only looks like it", () => {
    const line = (text: string) => NAMES_THE_FILE.test(text)
    expect(line('const s = readFileSync(join(import.meta.dir, "../surface/workbench.tsx"), "utf8")')).toBe(true)
    expect(line('const s = read("surface", "workbench.tsx")')).toBe(true)
    expect(line("const s = await Bun.file(new URL('./workbench.tsx', import.meta.url)).text()")).toBe(true)
    expect(line('const preset = willLaunch({ preset: "workbench", count: 2 })')).toBe(false)
    expect(line("const s = workbenchSource()")).toBe(false)
  })
})
