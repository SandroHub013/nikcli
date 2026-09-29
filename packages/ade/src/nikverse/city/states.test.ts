import { describe, expect, test } from "bun:test"
import { STATE_LABELS } from "../world/world.js"
import { jointsFor, mixJoints, walkSwing } from "./pose"
import { GLOW_COLOR, HAIR_COLORS, PERSON_COLORS, STATE_LOOK, hairColor, lookOf, personColor } from "./states"

const STATES = ["work", "perm", "ask", "err", "limit", "idle", "off", "closed"] as const

describe("what each state looks like", () => {
  test("every state ADE has has a look, and the world's labels name the same states", () => {
    expect(Object.keys(STATE_LOOK).sort()).toEqual([...STATES].sort())
    expect(Object.keys(STATE_LABELS).sort()).toEqual([...STATES].sort())
  })

  test("work types, a permission raises a hand with a mark, a question turns, an error puts the head in the hands", () => {
    expect(STATE_LOOK.work).toMatchObject({ pose: "type", screen: true, present: true, signal: "none" })
    expect(STATE_LOOK.perm).toMatchObject({ pose: "raise-hand", signal: "attention", glow: "amber" })
    expect(STATE_LOOK.ask).toMatchObject({ pose: "turn", signal: "question", glow: "blue" })
    expect(STATE_LOOK.err).toMatchObject({ pose: "head-hands", glow: "red" })
    expect(STATE_LOOK.limit.pose).toBe("lean-back")
    expect(STATE_LOOK.idle.pose).toBe("sit")
  })

  test("off and closed leave an empty chair and a dark screen", () => {
    for (const state of ["off", "closed"] as const) {
      expect(STATE_LOOK[state]).toMatchObject({ present: false, screen: false, glow: "off", signal: "none" })
    }
    for (const state of STATES) if (state !== "off" && state !== "closed") expect(STATE_LOOK[state].present).toBe(true)
  })

  test("only the two states that need the user carry a mark", () => {
    expect(STATES.filter((s) => STATE_LOOK[s].signal !== "none").sort()).toEqual(["ask", "perm"])
  })

  test("a state this world does not know is drawn as idle, and `constructor` is not a state", () => {
    expect(lookOf("brand-new-state")).toBe(STATE_LOOK.idle)
    expect(lookOf("constructor")).toBe(STATE_LOOK.idle)
    expect(lookOf("__proto__")).toBe(STATE_LOOK.idle)
    expect(lookOf("work")).toBe(STATE_LOOK.work)
  })

  test("every glow has a colour, and people's colours wrap and never fail", () => {
    for (const look of Object.values(STATE_LOOK)) expect(GLOW_COLOR[look.glow]).toBeNumber()
    expect(personColor(0)).toBe(PERSON_COLORS[0])
    expect(personColor(PERSON_COLORS.length + 2)).toBe(PERSON_COLORS[2])
    expect(personColor(-3)).toBe(PERSON_COLORS[3])
    expect(hairColor(HAIR_COLORS.length)).toBe(HAIR_COLORS[0])
    expect(personColor(2.7)).toBe(PERSON_COLORS[2])
  })
})

describe("the poses", () => {
  test("typing moves the hands, and the two hands are out of step", () => {
    const a = jointsFor("type", 0.05)
    const b = jointsFor("type", 0.2)
    expect(a.armLx).not.toBe(b.armLx)
    expect(Math.sign(a.armLx - jointsFor("type", 0).armLx)).not.toBe(Math.sign(a.armRx - jointsFor("type", 0).armRx))
    // Arms forward, at the keyboard.
    expect(a.armLx).toBeLessThan(-1)
  })

  test("a raised hand is up, over the head, and waves; the other arm rests", () => {
    const j = jointsFor("raise-hand", 0.3)
    expect(j.armRx).toBeLessThan(-2.5)
    expect(j.armLx).toBeGreaterThan(-1.5)
    expect(jointsFor("raise-hand", 0).armRz).not.toBe(jointsFor("raise-hand", 0.26).armRz)
  })

  test("turning turns the body toward the room; the head in the hands drops the head with both arms up", () => {
    expect(jointsFor("turn", 0).bodyYaw).toBeGreaterThan(0.8)
    const h = jointsFor("head-hands", 0)
    expect(h.headX).toBeGreaterThan(0.4)
    expect(h.armLx).toBeLessThan(-2)
    expect(h.armRx).toBeLessThan(-2)
  })

  test("leaning back leans the torso back", () => {
    expect(jointsFor("lean-back", 0).torsoX).toBeLessThan(-0.2)
    expect(jointsFor("sit", 0).torsoX).toBeCloseTo(0, 6)
  })

  test("a change of state blends from one pose to the other, and the ends are the poses", () => {
    const from = jointsFor("sit", 1)
    const to = jointsFor("raise-hand", 1)
    expect(mixJoints(from, to, 0)).toEqual(from)
    expect(mixJoints(from, to, 1)).toEqual(to)
    const half = mixJoints(from, to, 0.5)
    expect(half.armRx).toBeCloseTo((from.armRx + to.armRx) / 2, 9)
  })

  test("the walk swings the legs with the speed, and stands still at rest", () => {
    expect(walkSwing(0, 1)).toEqual({ leg: 0, arm: 0 })
    let widest = 0
    for (let t = 0; t < 2; t += 0.01) widest = Math.max(widest, Math.abs(walkSwing(3.2, t).leg))
    expect(widest).toBeGreaterThan(0.3)
    let runWidest = 0
    for (let t = 0; t < 2; t += 0.01) runWidest = Math.max(runWidest, Math.abs(walkSwing(6.4, t).leg))
    expect(runWidest).toBeGreaterThan(widest)
    // Arms swing against the legs.
    const s = walkSwing(3.2, 0.3)
    expect(Math.sign(s.arm)).toBe(-Math.sign(s.leg))
  })
})
