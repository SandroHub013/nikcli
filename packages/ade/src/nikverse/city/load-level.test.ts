import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { LEVELS_DIR } from "./test-cast"
import { loadLevel } from "./load-level"
import { LEVELS } from "./quality"
import { Texture } from "three/webgpu"

const fetchBytes = (missing: (url: string) => boolean = () => false) => async (url: string) => {
  if (missing(url)) throw new Error("404")
  return (await Bun.file(join(LEVELS_DIR, url.replace("file:///assets/levels/", ""))).arrayBuffer()) as ArrayBuffer
}
const deps = (missing?: (url: string) => boolean) => ({ base: "file:///assets/", fetchBytes: fetchBytes(missing) })

describe("what a level loads", () => {
  test("the people and the city, both, at the level asked for", async () => {
    const loaded = await loadLevel(LEVELS.media, deps())
    expect(loaded.level.id).toBe("media")
    expect(loaded.cast?.size).toBe(4)
    expect(loaded.kit).toBeDefined()
    expect(loaded.notes).toEqual([])
  })

  test("Alta without its files is Alta with Media's pictures, and says so", async () => {
    const loaded = await loadLevel(LEVELS.alta, deps((url) => url.includes("/alta/")))
    // The level is what runs (its pixel ratio, its effects); the files are Media's.
    expect([loaded.level.id, loaded.assets.id]).toEqual(["alta", "media"])
    expect(loaded.cast?.size).toBe(4)
    expect(loaded.kit).toBeDefined()
    expect(loaded.notes).toHaveLength(1)
    expect(loaded.notes[0]).toContain("Alta")
    expect(loaded.notes[0]).toContain("Media")
  })

  test("pictures that cannot be decoded leave the models with plain colours, and each file says so once", async () => {
    const decode = async () => {
      throw new Error("transcoder non partito")
    }
    const loaded = await loadLevel(LEVELS.bassa, { ...deps(), decode })
    expect(loaded.cast?.size).toBe(4)
    expect(loaded.kit).toBeDefined()
    expect(loaded.notes.length).toBeGreaterThanOrEqual(5)
    for (const note of loaded.notes) expect(note).toContain("transcoder non partito")
    // The models say plain colours; the floors say their baked light is missing.
    expect(loaded.notes.filter((note) => note.includes("tinte unite")).length).toBeGreaterThanOrEqual(5)
    expect(loaded.notes.filter((note) => note.includes("lightmap")).length).toBe(2)
    expect(new Set(loaded.notes).size).toBe(loaded.notes.length)
  })

  test("every picture that is decoded gives its CPU copy back once three has uploaded it, and not before", async () => {
    const made: Array<{ texture: Texture; closed: () => boolean }> = []
    const decode = async () => {
      let closed = false
      const texture = new Texture({ width: 4, height: 4, close: () => void (closed = true) } as never)
      made.push({ texture, closed: () => closed })
      return texture
    }
    await loadLevel(LEVELS.bassa, { ...deps(), decode })
    expect(made.length).toBeGreaterThan(10)
    expect(made.filter((m) => m.closed())).toEqual([])
    // three calls `onUpdate` when it has uploaded a texture.
    for (const m of made) m.texture.onUpdate?.(m.texture)
    expect(made.filter((m) => !m.closed())).toEqual([])
  })

  test("the people can fail and the city stay, and the other way round: each keeps its placeholders on its own", async () => {
    const noPeople = await loadLevel(LEVELS.bassa, deps((url) => url.includes("character_agent_rogue")))
    expect(noPeople.cast).toBeUndefined()
    expect(noPeople.kit).toBeDefined()
    expect(noPeople.notes[0]).toContain("personaggi")
    expect(noPeople.notes[0]).toContain("character_agent_rogue")
    const noCity = await loadLevel(LEVELS.bassa, deps((url) => url.endsWith("city.glb")))
    expect(noCity.kit).toBeUndefined()
    expect(noCity.cast?.size).toBe(4)
    expect(noCity.notes[0]).toContain("negozio e piazza")
  })

  test("with nothing there at Bassa there is nothing, and no fallback below it", async () => {
    const none = await loadLevel(LEVELS.bassa, deps(() => true))
    expect(none.level.id).toBe("bassa")
    expect(none.cast).toBeUndefined()
    expect(none.kit).toBeUndefined()
    expect(none.notes).toHaveLength(2)
  })

  test("a missing animations file fails the people, not the city: they share nothing but that file", async () => {
    const loaded = await loadLevel(LEVELS.media, deps((url) => url.endsWith("rig_animations.glb")))
    expect(loaded.cast).toBeUndefined()
    expect(loaded.kit).toBeDefined()
    expect(loaded.notes[0]).toContain("rig_animations")
  })
})
