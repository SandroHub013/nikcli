import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

/**
 * The local speech runtime (`parakeet.js`, `onnxruntime-web`) is not imported by anything. The two are still declared in
 * `package.json` (taking them out is a step of its own, it changes the lockfile), and that is harmless as long as nothing
 * imports them: the bundler emits neither their code nor the 24 MB WebAssembly file that came with them.
 */
const IMPORTING = /(from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)["'`](parakeet\.js|onnxruntime-web)[^"'`]*["'`]/

function sources(dir: string, into: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      if (name !== "node_modules") sources(path, into)
    } else if (/\.(ts|tsx)$/.test(name) && !name.endsWith(".test.ts")) into.push(path)
  }
  return into
}

const roots = [join(import.meta.dir, "..", ".."), join(import.meta.dir, "..", "..", "..", "ade", "src")]

describe("no local speech runtime in the bundle", () => {
  test("nothing under voice/src or ade/src imports parakeet.js or onnxruntime-web, statically or dynamically", () => {
    const found: string[] = []
    for (const root of roots)
      for (const file of sources(root)) if (IMPORTING.test(readFileSync(file, "utf8"))) found.push(file)
    expect(found).toEqual([])
  })

  test("the guard sees what it is looking for", () => {
    expect(IMPORTING.test(`const lib = await import("parakeet.js")`)).toBe(true)
    expect(IMPORTING.test(`import * as ort from 'onnxruntime-web/webgpu'`)).toBe(true)
    expect(IMPORTING.test(`import { createTranscriberFor } from "./asr/select"`)).toBe(false)
  })
})
