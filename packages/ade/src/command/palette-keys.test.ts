import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { paletteStep } from "./palette-keys"

const key = (key: string, extra: Partial<KeyboardEvent> = {}) =>
  ({ key, ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, ...extra }) as KeyboardEvent

test("Ctrl+N and Ctrl+P walk the palette, nothing else does", () => {
  expect(paletteStep(key("n"))).toBe(1)
  expect(paletteStep(key("p"))).toBe(-1)
  expect(paletteStep(key("N"))).toBe(1)
  expect(paletteStep(key("n", { ctrlKey: false }))).toBe(0)
  expect(paletteStep(key("n", { shiftKey: true }))).toBe(0)
  expect(paletteStep(key("k"))).toBe(0)
})

/*
 * Review area 2, MEDIO: the window's handler, in capture, took Ctrl+N as
 * `session.new` before the palette saw it. It lets the palette's steps
 * through, and before it runs any command. The handler lives inside the
 * workbench and cannot be called from a test.
 */
test("lint: the window's key handler leaves the palette its Ctrl+N and Ctrl+P", () => {
  const source = readFileSync(join(import.meta.dir, "../surface/workbench.tsx"), "utf8")
  const pass = source.indexOf(`if (target?.closest?.('[data-component="palette"]') && paletteStep(e) !== 0) return`)
  const run = source.indexOf("void runCommand(resolution.commandId)", pass)
  expect(pass).toBeGreaterThan(-1)
  expect(run).toBeGreaterThan(pass)
})
