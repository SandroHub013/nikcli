import { describe, expect, test } from "bun:test"
import { UNLOAD_AFTER_MS, createLifecycle } from "./lifecycle"

/** A clock the test moves by hand, and the calls the lifecycle makes on the world. */
function rig() {
  const calls: string[] = []
  let now = 0
  const timers = new Map<number, { at: number; run: () => void }>()
  let next = 0
  const lifecycle = createLifecycle({
    pause: () => calls.push("pause"),
    resume: () => calls.push("resume"),
    unload: () => calls.push("unload"),
    load: () => calls.push("load"),
    schedule: (run, ms) => {
      const id = next++
      timers.set(id, { at: now + ms, run })
      calls.push(`schedule ${ms}`)
      return () => {
        timers.delete(id)
        calls.push("cancel")
      }
    },
  })
  const advance = (ms: number) => {
    now += ms
    for (const [id, timer] of [...timers]) {
      if (timer.at <= now) {
        timers.delete(id)
        timer.run()
      }
    }
  }
  return { lifecycle, calls, advance, pending: () => timers.size }
}

describe("the world's lifecycle: pause when it cannot be seen, unload after five minutes", () => {
  test("it starts running, and unloads after exactly five minutes", () => {
    expect(UNLOAD_AFTER_MS).toBe(5 * 60_000)
  })

  test("hidden: it is told to pause at once and nothing is unloaded yet", () => {
    const { lifecycle, calls, advance } = rig()
    expect(lifecycle.phase()).toBe("running")
    lifecycle.setVisible(false)
    expect(lifecycle.phase()).toBe("paused")
    expect(calls).toEqual(["pause", `schedule ${UNLOAD_AFTER_MS}`])
    advance(UNLOAD_AFTER_MS - 1)
    expect(lifecycle.phase()).toBe("paused")
    expect(calls).not.toContain("unload")
  })

  test("after five minutes hidden the frame is unloaded", () => {
    const { lifecycle, calls, advance } = rig()
    lifecycle.setVisible(false)
    advance(UNLOAD_AFTER_MS)
    expect(lifecycle.phase()).toBe("unloaded")
    expect(calls).toEqual(["pause", `schedule ${UNLOAD_AFTER_MS}`, "unload"])
  })

  test("back before the five minutes: it resumes, the clock is stopped, nothing is loaded again", () => {
    const { lifecycle, calls, advance, pending } = rig()
    lifecycle.setVisible(false)
    advance(UNLOAD_AFTER_MS - 1000)
    lifecycle.setVisible(true)
    expect(lifecycle.phase()).toBe("running")
    expect(pending()).toBe(0)
    advance(UNLOAD_AFTER_MS * 2)
    expect(calls).toEqual(["pause", `schedule ${UNLOAD_AFTER_MS}`, "cancel", "resume"])
  })

  test("back after it was unloaded: the frame is loaded from nothing, not resumed", () => {
    const { lifecycle, calls, advance } = rig()
    lifecycle.setVisible(false)
    advance(UNLOAD_AFTER_MS)
    lifecycle.setVisible(true)
    expect(lifecycle.phase()).toBe("running")
    expect(calls.slice(3)).toEqual(["load"])
    expect(calls).not.toContain("resume")
  })

  test("the clock starts again each time it is hidden, not from the first time", () => {
    const { lifecycle, calls, advance } = rig()
    lifecycle.setVisible(false)
    advance(UNLOAD_AFTER_MS - 1000)
    lifecycle.setVisible(true)
    lifecycle.setVisible(false)
    advance(UNLOAD_AFTER_MS - 1000)
    expect(calls).not.toContain("unload")
    advance(1000)
    expect(calls).toContain("unload")
  })

  test("saying the same thing twice does nothing the second time", () => {
    const { lifecycle, calls } = rig()
    lifecycle.setVisible(true)
    expect(calls).toEqual([])
    lifecycle.setVisible(false)
    lifecycle.setVisible(false)
    expect(calls).toEqual(["pause", `schedule ${UNLOAD_AFTER_MS}`])
  })

  test("closing the panel leaves no clock behind", () => {
    const { lifecycle, advance, pending, calls } = rig()
    lifecycle.setVisible(false)
    lifecycle.dispose()
    expect(pending()).toBe(0)
    advance(UNLOAD_AFTER_MS * 2)
    expect(calls).not.toContain("unload")
  })
})
