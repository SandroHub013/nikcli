import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { LONG_TASK_LOG_MS, watchLongTasks } from "./long-task-log"

class FakeObserver {
  static supportedEntryTypes = ["longtask", "paint"]
  static last: FakeObserver | undefined
  disconnected = false
  observed: string[] = []
  constructor(private readonly callback: (list: { getEntries: () => { startTime: number; duration: number }[] }) => void) {
    FakeObserver.last = this
  }
  observe(options: { entryTypes: string[] }) {
    this.observed = options.entryTypes
  }
  disconnect() {
    this.disconnected = true
  }
  emit(...durations: number[]) {
    this.callback({ getEntries: () => durations.map((duration, index) => ({ startTime: 1000 + index, duration })) })
  }
}

describe("the page's long tasks", () => {
  test("a task past the threshold is a line in the log, a short one is not", () => {
    const lines: string[] = []
    watchLongTasks((text) => lines.push(text), { PerformanceObserver: FakeObserver })
    expect(FakeObserver.last?.observed).toEqual(["longtask"])
    FakeObserver.last?.emit(80, LONG_TASK_LOG_MS - 1, 6_400)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain("6400 ms")
  })

  test("stopping disconnects the observer", () => {
    const stop = watchLongTasks(() => {}, { PerformanceObserver: FakeObserver })
    stop()
    expect(FakeObserver.last?.disconnected).toBe(true)
  })

  test("a browser with no long-task entries gets nothing, and nothing throws", () => {
    expect(() => watchLongTasks(() => {}, {})()).not.toThrow()
    class Without extends FakeObserver {
      static override supportedEntryTypes = ["paint"]
    }
    expect(() => watchLongTasks(() => {}, { PerformanceObserver: Without })()).not.toThrow()
  })

  test("lint: the workbench starts it and stops it with the surface", () => {
    const source = readFileSync(join(import.meta.dir, "../surface/workbench.tsx"), "utf-8").replace(/\s+/g, " ")
    expect(source).toContain("onCleanup(watchLongTasks((text) => console.error(text)))")
  })
})
