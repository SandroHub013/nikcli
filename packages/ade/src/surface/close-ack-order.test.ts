import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/*
 * Architect's review of F6a, O1: Rust asks the same close question again when a click finds it acknowledged and
 * unanswered, and a page that is alive disarms that timer by acknowledging again. The acknowledgement therefore
 * comes before the guard that ignores a request while one is being handled.
 */
test("the close acknowledgement is sent before the 'already handling' guard", () => {
  const source = readFileSync(join(import.meta.dir, "workbench.tsx"), "utf8")
  const listener = source.slice(source.indexOf('listen<{ requestId?: number }>("ade-window-close-requested"'))
  const body = listener.slice(0, listener.indexOf('listen<{ requestId?: number }>("ade-window-hide-requested"'))
  const ack = body.indexOf('invoke("ade_close_ack"')
  const guard = body.indexOf("if (isHandlingClose) return")
  expect(ack).toBeGreaterThan(-1)
  expect(guard).toBeGreaterThan(-1)
  expect(ack).toBeLessThan(guard)
  // And only once: the second one, inside the handler, is gone.
  expect(body.split('invoke("ade_close_ack"').length - 1).toBe(1)
})
