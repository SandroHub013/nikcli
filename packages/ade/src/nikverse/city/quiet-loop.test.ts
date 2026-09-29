import { describe, expect, test } from "bun:test"
import { quietLoop } from "./quiet-loop"

/** A renderer as three makes it: an animation loop it started, a node clock, counters, and `render`. */
function fake(over: Record<string, unknown> = {}) {
  const log: string[] = []
  const frame = { frameId: 0, update: () => void (log.push("clock"), frame.frameId++) }
  const info = { autoReset: true, frame: -1, reset: () => void log.push("reset") }
  const renderer: any = {
    _animation: { stop: () => void log.push("stop") },
    _nodes: { nodeFrame: frame },
    info,
    render: (scene: unknown) => void log.push(`render ${String(scene)}`),
    ...over,
  }
  return { renderer, log, info, frame }
}

describe("the renderer's own loop", () => {
  test("it is stopped, once, and the city is told so", () => {
    const { renderer, log } = fake()
    expect(quietLoop(renderer)).toBe(true)
    expect(log).toEqual(["stop"])
  })

  test("each render resets the counters, advances the node clock, then draws: what the loop did every frame", () => {
    const { renderer, log, info } = fake()
    quietLoop(renderer)
    log.length = 0
    renderer.render("a", {})
    renderer.render("b", {})
    expect(log).toEqual(["reset", "clock", "render a", "reset", "clock", "render b"])
    expect(info.frame).toBe(2)
  })

  test("counters that are not to be reset are not reset", () => {
    const { renderer, log, info } = fake()
    info.autoReset = false
    quietLoop(renderer)
    log.length = 0
    renderer.render("a", {})
    expect(log).toEqual(["clock", "render a"])
  })

  test("a render inside a render is the same frame", () => {
    const { renderer, log } = fake()
    const inner = renderer.render
    renderer.render = (scene: string) => {
      inner(scene)
      if (scene === "outer") renderer.render("inner", {})
    }
    quietLoop(renderer)
    log.length = 0
    renderer.render("outer", {})
    expect(log.filter((l) => l === "clock")).toHaveLength(1)
    expect(log.filter((l) => l === "reset")).toHaveLength(1)
    expect(log).toContain("render inner")
  })

  test("a render that throws leaves the next one a frame of its own", () => {
    let fail = true
    const { renderer, log } = fake({
      render: (scene: unknown) => {
        if (fail) throw new Error("boom")
        log.push(`render ${String(scene)}`)
      },
    })
    quietLoop(renderer)
    expect(() => renderer.render("a", {})).toThrow("boom")
    fail = false
    log.length = 0
    renderer.render("b", {})
    expect(log).toEqual(["reset", "clock", "render b"])
  })

  test("a renderer without three's internals (the classic one, or another version) is left alone", () => {
    const classic = { render: () => {} }
    const before = classic.render
    expect(quietLoop(classic)).toBe(false)
    expect(classic.render).toBe(before)
    for (const missing of ["_animation", "_nodes", "info"]) {
      const { renderer } = fake({ [missing]: undefined })
      const original = renderer.render
      expect(quietLoop(renderer)).toBe(false)
      expect(renderer.render).toBe(original)
    }
  })

  test("it does not stop a loop it cannot restart if the parts do not fit", () => {
    const { renderer, log } = fake({ _nodes: { nodeFrame: { frameId: 0 } } })
    expect(quietLoop(renderer)).toBe(false)
    expect(log).toEqual([])
  })
})
