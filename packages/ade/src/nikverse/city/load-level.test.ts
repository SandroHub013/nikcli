import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { LEVELS_DIR } from "./test-cast"
import { loadLevel } from "./load-level"
import { LEVELS } from "./quality"

const fetchBytes = (missing: (url: string) => boolean = () => false) => async (url: string) => {
  if (missing(url)) throw new Error("404")
  return (await Bun.file(join(LEVELS_DIR, url.replace("file:///assets/levels/", ""))).arrayBuffer()) as ArrayBuffer
}
const deps = (missing?: (url: string) => boolean) => ({ base: "file:///assets/", fetchBytes: fetchBytes(missing) })

describe("what a level loads", () => {
  test("the people, at the level asked for", async () => {
    const loaded = await loadLevel(LEVELS.media, deps())
    expect(loaded.level.id).toBe("media")
    expect(loaded.cast?.size).toBe(4)
    expect(loaded.notes).toEqual([])
  })

  test("Alta without its files is Media, and says so", async () => {
    const loaded = await loadLevel(LEVELS.alta, deps((url) => url.includes("/alta/")))
    expect(loaded.level.id).toBe("media")
    expect(loaded.cast?.size).toBe(4)
    expect(loaded.notes).toHaveLength(1)
    expect(loaded.notes[0]).toContain("Alta")
    expect(loaded.notes[0]).toContain("Media")
  })

  test("one body missing fails the whole cast, and says which file: half a cast is worse than none", async () => {
    const noPeople = await loadLevel(LEVELS.bassa, deps((url) => url.includes("character_agent_rogue")))
    expect(noPeople.cast).toBeUndefined()
    expect(noPeople.notes).toHaveLength(1)
    expect(noPeople.notes[0]).toContain("personaggi")
    expect(noPeople.notes[0]).toContain("character_agent_rogue")
  })

  test("with nothing there at Bassa there is nothing, and no fallback below it", async () => {
    const none = await loadLevel(LEVELS.bassa, deps(() => true))
    expect(none.level.id).toBe("bassa")
    expect(none.cast).toBeUndefined()
    expect(none.notes).toHaveLength(1)
  })

  test("a missing animations file fails the people: they share it", async () => {
    const loaded = await loadLevel(LEVELS.media, deps((url) => url.endsWith("rig_animations.glb")))
    expect(loaded.cast).toBeUndefined()
    expect(loaded.notes[0]).toContain("rig_animations")
  })
})
