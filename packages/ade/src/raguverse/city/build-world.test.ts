import { afterAll, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { ensureWorld } from "./build-world"

/*
 * The world's bundle (`nikverse-assets/world/city.js`) is ignored by git, and `test:app` and the gate used to serve whatever somebody had
 * built last: a branch with the island showed the old city in ADE Test. `ensureWorld` builds it from the sources as they are, writes it
 * only when the bytes differ, and says which bundle it is; `test:app` and the gate call it, and the gate writes it in its JSON.
 */

const scratch = join(import.meta.dir, "..", "..", "..", ".ade-test", "world-test")
const file = join(scratch, "world", "city.js")
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

const source = (path: string) => readFileSync(join(import.meta.dir, "..", "..", "..", path), "utf8")

describe("ensureWorld", () => {
  test("a bundle that is not there is built, written, and named by its hash", async () => {
    rmSync(scratch, { recursive: true, force: true })
    const world = await ensureWorld({ file })
    expect(world.ok).toBe(true)
    if (!world.ok) return
    expect(world.written).toBe(true)
    const text = readFileSync(file, "utf8")
    expect(world.sha256).toBe(createHash("sha256").update(text).digest("hex"))
    expect(world.bytes).toBe(Buffer.byteLength(text))
    expect(world.modified).toBe(statSync(file).mtime.toISOString())
  })

  test("an old bundle, whatever its date, is replaced by the one of the sources", async () => {
    mkdirSync(join(scratch, "world"), { recursive: true })
    writeFileSync(file, "export const oldCity = true")
    // Newer than the sources by its date: the date says nothing, the bytes do.
    const future = new Date(Date.now() + 3_600_000)
    utimesSync(file, future, future)
    const world = await ensureWorld({ file })
    expect(world.ok && world.written).toBe(true)
    expect(readFileSync(file, "utf8")).not.toContain("oldCity")
    if (world.ok) expect(world.sha256).toBe(createHash("sha256").update(readFileSync(file, "utf8")).digest("hex"))
  })

  test("a bundle that is already the sources' is not written again, so cargo has nothing to rebuild for it", async () => {
    const first = await ensureWorld({ file })
    const before = statSync(file).mtimeMs
    const second = await ensureWorld({ file })
    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(second.written).toBe(false)
    expect(second.sha256).toBe(first.sha256)
    expect(statSync(file).mtimeMs).toBe(before)
  })

  test("--check builds and names it and writes nothing", async () => {
    rmSync(scratch, { recursive: true, force: true })
    const world = await ensureWorld({ file, check: true })
    expect(world.ok && world.written).toBe(false)
    expect(() => statSync(file)).toThrow()
  })
})

describe("who calls it", () => {
  test("test:app rebuilds the world before it starts ADE Test", () => {
    const script = source("scripts/test-app.ts")
    const built = script.indexOf("await ensureWorld()")
    expect(built).toBeGreaterThan(-1)
    expect(built).toBeLessThan(script.indexOf("tauriDevArgs(plan.configPath"))
  })

  test("the gate rebuilds it whether or not it starts ADE Test, and writes which bundle it measured in its JSON", () => {
    const gate = source("scripts/nikverse-gate.ts")
    const built = gate.indexOf("await ensureWorld()")
    expect(built).toBeGreaterThan(-1)
    // Before it looks for an ADE Test, not only in the branch that starts one.
    expect(built).toBeLessThan(gate.indexOf('if (flag("--start")'))
    expect(gate).toMatch(
      /world: \{ sha256: world\.sha256, bytes: world\.bytes, modified: world\.modified, rebuilt: world\.written \}/,
    )
  })
})
