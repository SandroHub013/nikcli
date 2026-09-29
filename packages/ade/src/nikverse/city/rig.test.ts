import { describe, expect, test } from "bun:test"
import { Vector3 } from "three/webgpu"
import { castOf, presentLevels } from "./test-cast"
import { unpack, readGlb } from "./glb"
import {
  AGENT_BODIES,
  BODIES,
  CLIP_NAME,
  LOD_UP_TO,
  RUN_ABOVE,
  ROLES,
  ROLE_OF_POSE,
  USER_BODY,
  advance,
  bodyOfLook,
  createRig,
  glbUrl,
  lodAt,
  paceOf,
  play,
  roleAtSpeed,
  showLod,
} from "./rig"
import { STATE_LOOK } from "./states"

describe("the cast as it ships", () => {
  for (const level of presentLevels()) {
    test(`${level}: four bodies, each with all the clips, the three LODs and the seat`, async () => {
      const cast = await castOf(level)
      expect([...cast.keys()].sort()).toEqual([...BODIES].sort())
      for (const [body, template] of cast) {
        for (const role of ROLES) {
          const clip = template.clips.get(role)!
          expect([body, role, clip.name]).toEqual([body, role, CLIP_NAME[role]])
          expect(clip.duration).toBeGreaterThan(0.3)
          expect(clip.tracks.length).toBeGreaterThan(10)
        }
        // The anchor the clips seat the pelvis by: a few tens of centimetres, not the floor and not the sky.
        expect(template.seatY).toBeGreaterThan(0.2)
        expect(template.seatY).toBeLessThan(0.6)
      }
    })
  }

  test("the user is the mage's own body and a session's is one of three, stable for a look", () => {
    expect(USER_BODY).toBe("user")
    expect(new Set(AGENT_BODIES).size).toBe(3)
    expect(bodyOfLook({ body: 0 })).toBe(AGENT_BODIES[0])
    expect(bodyOfLook({ body: 4 })).toBe(AGENT_BODIES[1])
    expect(bodyOfLook({ body: -2 })).toBe(AGENT_BODIES[2])
    expect(bodyOfLook({ body: 2.9 })).toBe(AGENT_BODIES[2])
    expect(glbUrl("./assets/", "media", "agent_rogue")).toBe("./assets/levels/media/character_agent_rogue.glb")
  })

  test("every state's pose has a clip, and the seated ones are the sit family, not the walk", () => {
    for (const look of Object.values(STATE_LOOK)) expect(ROLES).toContain(ROLE_OF_POSE[look.pose])
    expect(ROLE_OF_POSE[STATE_LOOK.work.pose]).toBe("type")
    expect(ROLE_OF_POSE[STATE_LOOK.perm.pose]).toBe("raise_hand")
    expect(ROLE_OF_POSE[STATE_LOOK.ask.pose]).toBe("turn")
    expect(ROLE_OF_POSE[STATE_LOOK.err.pose]).toBe("error")
    expect(ROLE_OF_POSE[STATE_LOOK.limit.pose]).toBe("lean")
    expect(ROLE_OF_POSE[STATE_LOOK.idle.pose]).toBe("sit")
  })

  test("the pictures come out of the file for the world to decode, and the rest still parses", async () => {
    const bytes = new Uint8Array(await Bun.file(`${import.meta.dir}/../../../src-tauri/nikverse-assets/levels/bassa/character_agent_knight.glb`).arrayBuffer())
    const glb = readGlb(bytes)
    const { buffer, pictures } = unpack(glb)
    expect([...pictures.keys()]).toEqual(["knight_texture"])
    expect(Object.keys(pictures.get("knight_texture")!)).toEqual(["map"])
    const png = pictures.get("knight_texture")!.map!
    expect([...png.subarray(1, 4)]).toEqual([0x50, 0x4e, 0x47])
    const bare = readGlb(new Uint8Array(buffer))
    expect(bare.json.images).toBeUndefined()
    expect(bare.json.textures).toBeUndefined()
    expect(bare.json.nodes).toHaveLength(glb.json.nodes!.length)
  })
})

describe("a rigged person", () => {
  const rigOf = async (body: (typeof BODIES)[number] = "agent_knight") => createRig((await castOf("bassa")).get(body)!)
  const at = (rig: ReturnType<typeof createRig>, name: string) => {
    rig.root.updateMatrixWorld(true)
    return rig.root.getObjectByName(name)!.getWorldPosition(new Vector3())
  }
  const run = (rig: ReturnType<typeof createRig>, role: Parameters<typeof play>[1], seconds: number) => {
    play(rig, role)
    advance(rig, 1)
    advance(rig, 1 + seconds)
  }

  test("each has its own skeleton: two people of one body do not move together", async () => {
    const a = await rigOf()
    const b = await rigOf()
    expect(a.root).not.toBe(b.root)
    expect(a.mixer).not.toBe(b.mixer)
    const before = at(b, "footl").toArray()
    run(a, "walk", 0.3)
    expect(at(a, "footl").distanceTo(new Vector3(...before))).toBeGreaterThan(0.03)
    expect(at(b, "footl").toArray()).toEqual(before)
  })

  test("a clip moves the bones: the walk swings the legs, the turn twists the body, the error bows the head", async () => {
    const seated = await rigOf()
    run(seated, "sit", 0.4)
    const walking = await rigOf()
    run(walking, "walk", 0.4)
    expect(Math.abs(at(walking, "footl").z - at(seated, "footl").z)).toBeGreaterThan(0.1)
    const turned = await rigOf()
    run(turned, "turn", 0.5)
    expect(Math.abs(at(turned, "head").x - at(seated, "head").x)).toBeGreaterThan(0.02)
    const bowed = await rigOf()
    run(bowed, "error", 0.5)
    expect(at(bowed, "head").z).toBeLessThan(at(seated, "head").z - 0.02)
  })

  // N3's arm motion for these clips is on IK controls, which three.js does not solve, and the exporter did not
  // bake it onto the arm bones: a session that needs a permission raises no hand. `failing` turns red when the
  // export is fixed, and the test is then written as it should be.
  test.failing("the raised hand of a permission is over the head (N3: the arm clips are not baked from IK)", async () => {
    const raised = await rigOf()
    run(raised, "raise_hand", 0.5)
    const hand = Math.max(at(raised, "handl").y, at(raised, "handr").y)
    expect(hand).toBeGreaterThan(at(raised, "head").y)
  })

  test("a change of role blends: the old clip fades out and the new one takes over", async () => {
    const rig = await rigOf()
    play(rig, "type")
    advance(rig, 1)
    play(rig, "raise_hand")
    advance(rig, 1.05)
    const early = [rig.actions.get("type")!.getEffectiveWeight(), rig.actions.get("raise_hand")!.getEffectiveWeight()]
    expect(early[0]).toBeGreaterThan(0.1)
    expect(early[1]).toBeLessThan(0.9)
    advance(rig, 1.3)
    advance(rig, 1.55)
    expect(rig.actions.get("type")!.getEffectiveWeight()).toBeCloseTo(0, 5)
    expect(rig.actions.get("raise_hand")!.getEffectiveWeight()).toBeCloseTo(1, 5)
    expect(rig.role).toBe("raise_hand")
  })

  test("playing the role it already plays does not restart it", async () => {
    const rig = await rigOf()
    play(rig, "type")
    advance(rig, 1)
    advance(rig, 1.3)
    const at = rig.actions.get("type")!.time
    play(rig, "type")
    expect(rig.actions.get("type")!.time).toBe(at)
  })

  test("the mixer takes the world's clock, and a long gap is not played through", async () => {
    const rig = await rigOf()
    play(rig, "type")
    advance(rig, 5)
    const first = rig.actions.get("type")!.time
    advance(rig, 5.1)
    expect(rig.actions.get("type")!.time - first).toBeCloseTo(0.1, 5)
    const before = rig.actions.get("type")!.time
    advance(rig, 500)
    expect(rig.actions.get("type")!.time - before).toBeLessThanOrEqual(0.25 + 1e-9)
    advance(rig, 400)
    expect(rig.actions.get("type")!.time).toBeDefined()
  })

  test("one LOD is drawn at a time, none when far, and the accessories go with the farthest", async () => {
    const rig = await rigOf("agent_barbarian")
    expect(rig.accessories.length).toBeGreaterThanOrEqual(2)
    const shown = () => rig.lods.map((m) => m.visible)
    showLod(rig, 0)
    expect(shown()).toEqual([true, false, false])
    expect(rig.accessories.every((a) => a.visible)).toBe(true)
    showLod(rig, 1)
    expect(shown()).toEqual([false, true, false])
    expect(rig.accessories.every((a) => a.visible)).toBe(true)
    showLod(rig, 2)
    expect(shown()).toEqual([false, false, true])
    expect(rig.accessories.some((a) => a.visible)).toBe(false)
    showLod(rig, undefined)
    expect(shown()).toEqual([false, false, false])
    showLod(rig, 0)
    expect(rig.accessories.every((a) => a.visible)).toBe(true)
  })

  test("a skinned body is never culled by the box it was measured in", async () => {
    const rig = await rigOf()
    expect(rig.lods.every((m) => m.frustumCulled === false)).toBe(true)
  })
})

describe("which LOD, and how fast to walk", () => {
  test("0 within 7.5 m, 1 within 15, 2 within 30, and nothing past it: the impostor's", () => {
    expect(LOD_UP_TO).toEqual([7.5, 15, 30])
    expect([lodAt(0), lodAt(7.5), lodAt(7.51), lodAt(15), lodAt(15.01), lodAt(30), lodAt(30.01)]).toEqual([0, 0, 1, 1, 2, 2, undefined])
  })

  test("standing, walking or running by the speed, with the walk of 3.2 m/s and the run of 6.4 on the right sides", () => {
    expect([roleAtSpeed(0), roleAtSpeed(0.04), roleAtSpeed(0.06), roleAtSpeed(3.2), roleAtSpeed(RUN_ABOVE), roleAtSpeed(6.4)]).toEqual([
      "idle",
      "idle",
      "walk",
      "walk",
      "walk",
      "run",
    ])
    expect(RUN_ABOVE).toBeGreaterThan(3.2)
    expect(RUN_ABOVE).toBeLessThan(6.4)
  })

  test("the clip plays faster the faster the character goes, within limits, and not at all scaled when it is not walking", () => {
    expect(paceOf("walk", 3.2)).toBeGreaterThan(paceOf("walk", 1.6))
    expect(paceOf("walk", 100)).toBe(1.7)
    expect(paceOf("walk", 0.01)).toBe(0.6)
    expect(paceOf("run", 6.4)).toBeGreaterThan(paceOf("run", 5))
    expect(paceOf("run", 100)).toBe(1.5)
    expect(paceOf("idle", 0)).toBe(1)
    expect(paceOf("sit", 3)).toBe(1)
  })
})
