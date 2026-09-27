import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createInFlight } from "./in-flight"

test("a pane has a line in flight until every line for it settles, failed ones too", async () => {
  const flight = createInFlight()
  let finishA!: () => void
  const a = flight.track("p1", new Promise<void>((resolve) => (finishA = resolve)))
  const b = flight.track("p1", Promise.reject(new Error("closed")))
  expect(flight.has("p1")).toBe(true)
  expect(flight.has("p2")).toBe(false)
  await b.catch(() => {})
  expect(flight.has("p1")).toBe(true)
  finishA()
  await a
  expect(flight.has("p1")).toBe(false)
})

/*
 * Review area 2, MEDIO: a round found a pane free for its first held line,
 * started it without waiting, and found the same pane free for the second:
 * the hook had not said «busy» yet. The workbench counts its lines and
 * `freeNow` reads the count first. Both live inside the workbench.
 */
test("lint: every line ADE types is counted, and freeNow asks first", () => {
  const source = readFileSync(join(import.meta.dir, "../surface/workbench.tsx"), "utf8")
  expect(source).toContain("return paneId === undefined ? job() : linesInFlight.track(paneId, lineQueue(paneId, job))")
  const free = source.slice(source.indexOf("const freeNow = async"), source.indexOf("const freeNow = async") + 300)
  expect(free).toContain("if (linesInFlight.has(paneId)) return false")
})
