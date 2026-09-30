import { describe, expect, test } from "bun:test"
import { createLoadLog, shortUrl, type LoadEntry } from "./load-log"

function page() {
  let now = 0
  const win = {
    performance: { now: () => now },
    document: { documentElement: { dataset: {} as DOMStringMap } },
  }
  return {
    win,
    at: (ms: number) => (now = ms),
    entries: () => (win as unknown as { __nikverseLoad: LoadEntry[] }).__nikverseLoad,
    data: win.document.documentElement.dataset,
  }
}

describe("the opening's phases", () => {
  test("each phase closes when the next opens; the one left open is where the opening stopped", () => {
    const p = page()
    const log = createLoadLog(p.win)
    p.at(100)
    log.phase("gpu")
    p.at(130)
    log.phase("renderer")
    p.at(1330)
    log.phase("assets")
    expect(p.data.load).toBe("assets")
    expect(p.entries()).toEqual([
      { name: "gpu", kind: "phase", at: 100, ms: 30 },
      { name: "renderer", kind: "phase", at: 130, ms: 1200 },
      { name: "assets", kind: "phase", at: 1330 },
    ])
  })

  test("pieces run side by side with their own times, a failed one says so, and `done` says ready", () => {
    const p = page()
    const log = createLoadLog(p.win)
    log.phase("assets")
    p.at(10)
    const glb = log.piece("fetch levels/media/city.glb")
    const png = log.piece("decode 1")
    p.at(50)
    png(true)
    p.at(90)
    glb()
    glb()
    log.done()
    expect(p.entries().slice(1)).toEqual([
      { name: "fetch levels/media/city.glb", kind: "piece", at: 10, ms: 80 },
      { name: "decode 1", kind: "piece", at: 10, ms: 40, failed: true },
    ])
    expect(p.entries()[0].ms).toBe(90)
    expect(p.data.load).toBe("ready")
  })

  test("after the opening, the pictures decoded as people come near are not written", () => {
    const p = page()
    const log = createLoadLog(p.win)
    log.phase("assets")
    log.done()
    log.piece("decode 9")()
    expect(p.entries().map((e) => e.name)).toEqual(["assets"])
  })

  test("a piece's name keeps the end of the address", () => {
    expect(shortUrl("plugin://nikverse/assets/levels/media/city.glb?v=3")).toBe("levels/media/city.glb")
  })
})
