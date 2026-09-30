import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { LEVELS_DIR, presentLevels } from "./test-cast"
import { characterTriangles, imageSizes, nodeNamed, readGlb, subtree, trianglesOf, wearsAccessories, type Glb } from "./glb"
import { ktx2Format, ktx2GpuBytes, ktx2Size } from "./ktx2-header"
import { CLIP_NAME, BODIES, ROLES } from "./rig"
import { LEVEL_IDS } from "./quality"

/**
 * The generator's ceilings (`config.json` of N3, copied next to the assets as `budget.json`) against the files
 * that ship. The numbers are read from the files, not from the generator's report: the report says what the
 * generator meant, the file says what the world loads.
 *
 * Bassa and Media are in the repo. Alta's 2K set is a developer's local copy (`sync-nikverse-assets --alta`),
 * so the checks run over the levels that are here, and Bassa and Media must be.
 */

interface Budget {
  levels: Record<string, { label: string; texture: number; lightmap: number; lods: number[] }>
  budget: {
    asset_bassa_media_mb: number
    alta_download_mb: number
    char_lod0_tris: number
    char_lod1_tris: number
    char_lod2_tris: number
    shop_tris: number
    plaza_tris: number
    desk_tris: number
    surroundings_tris: number
    island_tris: number
  }
  cast: { user: string; agents: string[] }
}

const budget: Budget = JSON.parse(readFileSync(join(LEVELS_DIR, "budget.json"), "utf8"))
const MB = 1024 * 1024
const levelFile = (level: string, name: string) => join(LEVELS_DIR, level, name)
const glbOf = (path: string): Glb => readGlb(new Uint8Array(readFileSync(path)))
const character = (level: string, body: string) => glbOf(levelFile(level, `character_${body}.glb`))
const city = (level: string) => glbOf(levelFile(level, "city.glb"))
/** The lightmaps of a level: every file of its folder (the city names them, `kit.test.ts` holds the two to each other). */
const lightmaps = (level: string) => readdirSync(levelFile(level, "lightmap")).map((name) => levelFile(level, `lightmap/${name}`))
/** The size of a level's package on disk: characters, city, lightmaps, and the animations shared by all. */
const packBytes = (level: string) =>
  BODIES.reduce((sum, body) => sum + statSync(levelFile(level, `character_${body}.glb`)).size, 0) +
  statSync(levelFile(level, "city.glb")).size +
  lightmaps(level).reduce((sum, file) => sum + statSync(file).size, 0) +
  statSync(join(LEVELS_DIR, "rig_animations.glb")).size
/** The parts of a kind a city file has for its chiringuiti: `chir_roof0_`, `chir_roof1_`... (the prefixes of its nodes). */
const partPrefixes = (glb: Glb, kind: string): string[] => [
  ...new Set((glb.json.nodes ?? []).flatMap((node) => new RegExp(`^chir_${kind}\\d*_`).exec(node.name ?? "")?.[0] ?? [])),
]

/** The picture files inside a glb, as bytes: the KTX2 the extension carries. */
const picturesOf = (glb: Glb): Uint8Array[] =>
  (glb.json.images ?? []).map((image) => {
    const view = glb.json.bufferViews![image.bufferView!]
    const start = view.byteOffset ?? 0
    return glb.bin.subarray(start, start + view.byteLength)
  })

/** The triangles of every node whose name starts with `prefix`. */
const trianglesNamed = (glb: Glb, prefix: string) =>
  (glb.json.nodes ?? []).reduce((sum, node, i) => sum + (node.name?.startsWith(prefix) ? trianglesOf(glb, i) : 0), 0)

describe("the shipped assets against the generator's ceilings", () => {
  test("Bassa and Media are in the repo, the levels of the budget are the levels of the world, and the cast is the world's", () => {
    expect(presentLevels()).toEqual(expect.arrayContaining(["bassa", "media"]))
    expect(Object.keys(budget.levels).sort()).toEqual([...LEVEL_IDS].sort())
    expect(budget.cast.agents).toHaveLength(3)
    expect(BODIES).toHaveLength(1 + budget.cast.agents.length)
  })

  test("Bassa and Media together, as the installer carries them, weigh less than their ceiling", () => {
    const bytes = packBytes("bassa") + packBytes("media") - statSync(join(LEVELS_DIR, "rig_animations.glb")).size
    expect(bytes).toBeLessThan(budget.budget.asset_bassa_media_mb * MB)
  })

  test("the animations are one file for every body: the clips the world plays, on a skeleton the bodies share", () => {
    const animations = glbOf(join(LEVELS_DIR, "rig_animations.glb"))
    const names = (animations.json.animations ?? []).map((a) => a.name)
    for (const role of ROLES) expect(names).toContain(CLIP_NAME[role])
    expect(animations.json.meshes).toBeUndefined()
    // A clip finds its bones by name: every bone of the animations' skeleton is in every body, at every level.
    const bones = (animations.json.nodes ?? []).map((n) => n.name).filter(Boolean)
    expect(bones.length).toBeGreaterThan(20)
    for (const level of presentLevels()) {
      for (const body of BODIES) {
        const have = new Set((character(level, body).json.nodes ?? []).map((n) => n.name))
        expect([level, body, bones.filter((bone) => !have.has(bone))]).toEqual([level, body, []])
      }
    }
  })

  for (const level of ["bassa", "media", "alta"]) {
    describe(level, () => {
      const skip = !presentLevels().includes(level)
      const run = skip ? test.skip : test

      run("the pack (characters, city, lightmaps, and the animations shared by all) weighs less than the ceiling for a level", () => {
        const bytes = packBytes(level)
        // The ceiling is for Bassa and Media together in the installer's words, but each alone is held to it: Alta's is a separate download, with a ceiling of its own.
        expect(bytes).toBeLessThan((level === "alta" ? budget.budget.alta_download_mb : budget.budget.asset_bassa_media_mb) * MB)
      })

      run("each body's triangles at each LOD are within the ceiling for that LOD, and each LOD is lighter than the one before", () => {
        for (const body of BODIES) {
          const glb = character(level, body)
          const [lod0, lod1, lod2] = [0, 1, 2].map((lod) => characterTriangles(glb, lod as 0 | 1 | 2))
          expect([body, lod0, lod0 <= budget.budget.char_lod0_tris]).toEqual([body, lod0, true])
          expect([body, lod1, lod1 <= budget.budget.char_lod1_tris]).toEqual([body, lod1, true])
          expect([body, lod2, lod2 <= budget.budget.char_lod2_tris]).toEqual([body, lod2, true])
          expect(lod1).toBeLessThan(lod0)
          expect(lod2).toBeLessThan(lod1)
        }
      })

      run("each chiringuito, whatever roof, counter and sign it got, and the island are within their ceilings", () => {
        const glb = city(level)
        const base = trianglesNamed(glb, "chir_base_")
        const [roofs, bars, signs] = ["roof", "bar", "sign"].map((kind) => partPrefixes(glb, kind))
        expect(Math.min(roofs.length, bars.length, signs.length)).toBeGreaterThan(0)
        // A chiringuito is the base and one of each: the heaviest of each together is the heaviest chiringuito.
        const heaviest = (prefixes: string[]) => Math.max(...prefixes.map((prefix) => trianglesNamed(glb, prefix)))
        const tris = base + heaviest(roofs) + heaviest(bars) + heaviest(signs)
        expect([tris, tris > 1000 && tris <= budget.budget.shop_tris]).toEqual([tris, true])
        // The seats, the tables and the laptops are in the base with the rest of the fixtures: the base holds the desks' ceiling and the rest.
        const island = trianglesNamed(glb, "island_") + trianglesNamed(glb, "plaza_")
        expect([island, island <= budget.budget.island_tris]).toEqual([island, true])
        expect(trianglesNamed(glb, "env_")).toBeLessThanOrEqual(budget.budget.surroundings_tris)
      })

      // The pictures are KTX2 in the GPU's own block format (BC1/BC5), which the GPU holds as they are: what it holds for them
      // is what the files say (the level index's uncompressed sizes). Media's are 14 MB and Bassa's 5, where the same pictures as
      // PNG were 104 and 30 (RGBA, four bytes a texel): that is how the frame gets under its 130 MB.
      run("the pictures inside are square and no larger than the level's, and what the GPU holds for all of them is under the frame's budget", () => {
        let bytes = 0
        for (const body of BODIES) {
          const glb = character(level, body)
          const sizes = imageSizes(glb)
          expect(sizes).toHaveLength(1)
          expect(sizes[0]).toEqual({ width: budget.levels[level].texture, height: budget.levels[level].texture })
          bytes += picturesOf(glb).reduce((sum, file) => sum + ktx2GpuBytes(file), 0)
        }
        const shop = city(level)
        for (const size of imageSizes(shop)) {
          expect(size.width).toBe(size.height)
          expect(size.width).toBeLessThanOrEqual(budget.levels[level].texture)
        }
        bytes += picturesOf(shop).reduce((sum, file) => sum + ktx2GpuBytes(file), 0)
        for (const file of lightmaps(level)) {
          const picture = new Uint8Array(readFileSync(file))
          expect(ktx2Size(picture)).toEqual({ width: budget.levels[level].lightmap, height: budget.levels[level].lightmap })
          bytes += ktx2GpuBytes(picture)
        }
        // The plan's ceiling for the pictures in memory is 40 MB; Alta's 2K set is 60 MB (lightmaps included) and is a download of its own (the plan lets
        // Alta use Media's 1K until it exists), so it gets room for that set and no more.
        expect(bytes).toBeLessThan((level === "alta" ? 64 : 40) * MB)
      })

      // The architect's rule: no PNG in the package, not even at Bassa; every picture is KTX2 in a block format the GPU reads as it is
      // (BC1 for colour and data, BC5 for normals), zstd, and says so under our extension.
      run("the pictures in the package are KTX2 in BC and none is a PNG, the lightmaps' included", () => {
        const glbs = [...BODIES.map((body) => character(level, body)), city(level)]
        for (const glb of glbs) {
          for (const image of glb.json.images ?? []) expect(image.mimeType).toBe("image/ktx2")
          for (const file of picturesOf(glb)) {
            const { vkFormat, supercompression } = ktx2Format(file)
            expect([131, 132, 141]).toContain(vkFormat)
            expect(supercompression).toBe(2)
          }
        }
        for (const file of lightmaps(level)) {
          expect(file.endsWith(".ktx2")).toBe(true)
          expect([131, 132, 141]).toContain(ktx2Format(new Uint8Array(readFileSync(file))).vkFormat)
        }
      })

      // A rewrite of a file's BIN that leaves out what nothing points to by `bufferView.byteOffset` drops the meshopt-compressed
      // geometry too: it is addressed by the extension's own `buffer`/`byteOffset`/`byteLength` (the view's are of a virtual fallback
      // buffer). The loader then fails with «Length out of range of buffer» on every model. N3's first KTX2 delivery did exactly that.
      run("every byte range a file points to is inside its BIN, the meshopt-compressed geometry's included", () => {
        const files = [...BODIES.map((body) => character(level, body)), city(level), glbOf(join(LEVELS_DIR, "rig_animations.glb"))]
        for (const glb of files) {
          const declared = glb.json.buffers?.[0]?.byteLength ?? 0
          expect(declared).toBeLessThanOrEqual(glb.bin.byteLength)
          for (const [i, view] of (glb.json.bufferViews ?? []).entries()) {
            const meshopt = (view as { extensions?: { EXT_meshopt_compression?: { buffer: number; byteOffset?: number; byteLength: number } } }).extensions
              ?.EXT_meshopt_compression
            const range = meshopt
              ? { buffer: meshopt.buffer, at: meshopt.byteOffset ?? 0, length: meshopt.byteLength }
              : { buffer: (view as { buffer?: number }).buffer ?? 0, at: view.byteOffset ?? 0, length: view.byteLength }
            // A fallback buffer (`extensions.EXT_meshopt_compression.fallback`) is virtual: no bytes are behind it.
            if (!meshopt && range.buffer !== 0) continue
            expect([i, range.at + range.length <= glb.bin.byteLength]).toEqual([i, true])
          }
        }
      })

      run("what the world asks of the files is in them: the LODs, the anchors, the skin and the one extension the loader has a decoder for", () => {
        for (const body of BODIES) {
          const glb = character(level, body)
          for (const lod of [0, 1, 2]) expect(glb.json.nodes!.some((n) => n.name === `${body}_lod${lod}`)).toBe(true)
          expect(nodeNamed(glb, `${body}_anchor_seat`)).toBeGreaterThanOrEqual(0)
          expect(nodeNamed(glb, `${body}_anchor_head`)).toBeGreaterThanOrEqual(0)
          expect(glb.json.skins).toHaveLength(1)
          expect([...(glb.json.extensionsRequired ?? [])].sort()).toEqual(["EXT_meshopt_compression", "NIKVERSE_texture_ktx2"])
        }
        expect([...(city(level).json.extensionsRequired ?? [])].sort()).toEqual(["EXT_meshopt_compression", "NIKVERSE_texture_ktx2"])
      })
    })
  }

  test("the accessories are not drawn at the farthest LOD, which is what the ceiling for it counts", () => {
    expect([wearsAccessories(0), wearsAccessories(1), wearsAccessories(2)]).toEqual([true, true, false])
    // With the hat counted, the barbarian's farthest LOD at Bassa would be over 1500: the rule is what keeps it under.
    const glb = character("bassa", "agent_barbarian")
    const withHat = trianglesOf(glb, nodeNamed(glb, "agent_barbarian_lod2")) + 732
    expect(withHat).toBeGreaterThan(budget.budget.char_lod2_tris)
    expect(characterTriangles(glb, 2)).toBeLessThanOrEqual(budget.budget.char_lod2_tris)
    // The parts of a character that are not a body: found under the head or the hips, not at the scene's root.
    expect(subtree(glb, nodeNamed(glb, "root")).length).toBeGreaterThan(20)
  })
})
