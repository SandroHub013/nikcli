import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/*
 * SES-13: `attachTerminal` returns a `detach` that the pane's `onCleanup` calls. When a pane attaches a second time
 * (a new element for the same session), the first `detach` runs inside the second attach, and then runs AGAIN when the
 * first pane's cleanup fires. That second call cleared the shared fields (`kittyKeys`, `element`, `uncover`, `copied`,
 * `detach`) that the second attach had just set: the live terminal lost its Enter keys, its element and its detach.
 *
 * A real attach needs xterm, its image addon and a canvas, which happy-dom does not give, and the registry cannot be
 * loaded where `@xterm/addon-image` is missing. So, as the neighbouring fit lint does, the shape of `detach` is read
 * from the source: it runs once, and it touches the shared fields only while it is still the session's own.
 */
const registry = readFileSync(join(import.meta.dir, "registry.ts"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "")

const start = registry.indexOf("  const detach = () => {")
const body = start === -1 ? "" : registry.slice(start, registry.indexOf("\n  }\n", start))

describe("a detach that runs twice does not undo the attach after it (SES-13)", () => {
  test("`detach` is found, and it has a flag declared before it", () => {
    expect(start).toBeGreaterThan(-1)
    const before = registry.slice(Math.max(0, start - 200), start)
    expect(before.includes("let detached = false")).toBe(true)
  })

  test("it returns at once when it already ran, and sets the flag first", () => {
    const early = body.indexOf("if (detached) return")
    const set = body.indexOf("detached = true")
    expect(early).toBeGreaterThan(-1)
    expect(set).toBeGreaterThan(early)
    expect(set).toBeLessThan(body.indexOf("observer.disconnect()"))
  })

  test("it disposes its own observer and handlers before anything shared is touched", () => {
    const own = ["observer.disconnect()", "stopCellWatch()", "settler.cancel()", "inputHandler?.dispose()", "modeWatch?.dispose()"]
    const guard = body.indexOf("if (session.detach !== detach) return")
    expect(guard).toBeGreaterThan(-1)
    for (const call of own) {
      const at = body.indexOf(call)
      expect([call, at > -1 && at < guard]).toEqual([call, true])
    }
  })

  test("the shared fields are cleared only while this detach is the session's own", () => {
    const guard = body.indexOf("if (session.detach !== detach) return")
    expect(guard).toBeGreaterThan(-1)
    for (const field of ["session.uncover = undefined", "session.copyBlocked = undefined", "session.copied = undefined", "session.kittyKeys = undefined", "session.element = undefined", "session.detach = undefined"]) {
      const at = body.indexOf(field)
      expect([field, at > guard]).toEqual([field, true])
    }
  })
})
