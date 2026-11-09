import { describe, expect, test } from "bun:test"
import type { PaneSummary } from "../bridge/host"
import type { ParseContext } from "../intent/parse"
import { createInitialDialogState, transition } from "./session"

/*
 * MOD-20: a send the voice agent made while another question was being asked waits in line, and was asked whenever the
 * first one ended, however long after: the user said «no» to the first, and an hour later a question about a message
 * they had forgotten was read to them (and a yes would send it). A send that waited more than ten minutes is refused,
 * and its sender is told.
 */

const pane: PaneSummary = {
  id: "pA",
  index: 1,
  title: "Alfa",
  status: "idle",
  hasLiveProcess: true,
  isBrowser: false,
  isFile: false,
}
const ctx: ParseContext = { panes: [pane], focusedPaneId: "pA" }
const MINUTE = 60_000

/** A send asked (m1), and a second one (m2) queued behind it at `10_100`. */
function withQueuedSend() {
  let state = createInitialDialogState("idle")
  state = transition(state, { type: "send_requested", id: "m1", to: "Alfa", text: "uno" }, 10_000, ctx).state
  state = transition(state, { type: "send_requested", id: "m2", to: "Beta", text: "due" }, 10_100, ctx).state
  expect(state.queuedSend?.id).toBe("m2")
  return state
}

describe("a queued send that waited too long is refused (MOD-20)", () => {
  test("promoted 11 minutes later, it is refused and asks nothing", () => {
    const state = withQueuedSend()
    const out = transition(state, { type: "utterance", text: "no" }, 10_100 + 11 * MINUTE, ctx)

    expect(out.effects).toContainEqual({ type: "confirm_send", id: "m2", approved: false })
    expect(out.state.pendingSend).toBeUndefined()
    expect(out.state.queuedSend).toBeUndefined()
    const said = out.effects.filter((e) => e.type === "speak").map((e) => (e as { text: string }).text)
    expect(said.some((text) => text.includes("Beta") && text.includes("rimasto in coda troppo a lungo"))).toBe(true)
    // Nothing is asked: no question, no timer for a confirmation.
    expect(said.some((text) => text.includes("Confermi"))).toBe(false)
    expect(out.effects.some((e) => e.type === "start_timer")).toBe(false)
  })

  test("promoted after a minute, it is asked as before", () => {
    const state = withQueuedSend()
    const out = transition(state, { type: "utterance", text: "no" }, 10_100 + MINUTE, ctx)

    expect(out.state.pendingSend?.id).toBe("m2")
    expect(out.effects).not.toContainEqual({ type: "confirm_send", id: "m2", approved: false })
    const said = out.effects.filter((e) => e.type === "speak").map((e) => (e as { text: string }).text)
    expect(said.some((text) => text.includes("Confermi"))).toBe(true)
  })

  test("the time is kept from when it was queued, not from when the first one was asked", () => {
    let state = createInitialDialogState("idle")
    state = transition(state, { type: "send_requested", id: "m1", to: "Alfa", text: "uno" }, 10_000, ctx).state
    // Queued 9 minutes in: asked at minute 11 of the first, that is 2 minutes after it joined the line.
    state = transition(state, { type: "send_requested", id: "m2", to: "Beta", text: "due" }, 10_000 + 9 * MINUTE, ctx).state
    const out = transition(state, { type: "utterance", text: "no" }, 10_000 + 11 * MINUTE, ctx)
    expect(out.state.pendingSend?.id).toBe("m2")
  })
})

/*
 * Review of ade/moduli-piccoli, B2: the refusal returned a result, so a plan queued behind the expired send never got
 * its turn: the state went to idle, and idle never asks a queued plan. It stayed there for hours, and every plan that
 * came meanwhile was refused with «Ho già un piano in coda».
 */
describe("a plan queued behind an expired send is asked at once (MOD-20, review B2)", () => {
  const plan = {
    steps: [{ action: "send_prompt" as const, paneIndex: 1, text: "fai" }],
    refusals: [] as string[],
  }

  test("asleep, send then plan, wake after 11 minutes: the send is refused and the plan is asked in the same step", () => {
    let state = createInitialDialogState("asleep")
    state = transition(state, { type: "send_requested", id: "m2", to: "Beta", text: "due" }, 10_000, ctx).state
    state = transition(state, { type: "plan_ready", ...plan }, 10_000 + MINUTE, ctx).state
    expect(state.queuedSend?.id).toBe("m2")
    expect(state.queuedPlan).toBeDefined()

    const out = transition(state, { type: "wake" }, 10_000 + 11 * MINUTE, ctx)

    expect(out.effects).toContainEqual({ type: "confirm_send", id: "m2", approved: false })
    const said = out.effects.filter((e) => e.type === "speak").map((e) => (e as { text: string }).text)
    expect(said.some((text) => text.includes("Beta") && text.includes("rimasto in coda troppo a lungo"))).toBe(true)
    // Both are said, the refusal first, and the plan is now the question being asked.
    expect(said.length).toBe(2)
    expect(said[0]!.includes("rimasto in coda")).toBe(true)
    expect(out.state.queuedPlan).toBeUndefined()
    expect(out.state.pendingPlan).toBeDefined()
    expect(out.state.status).toBe("confirming")
    expect(out.effects.some((e) => e.type === "start_timer")).toBe(true)
  })

  test("with no plan behind it, the refusal still leaves the dialogue idle and says only the refusal", () => {
    let state = createInitialDialogState("asleep")
    state = transition(state, { type: "send_requested", id: "m2", to: "Beta", text: "due" }, 10_000, ctx).state
    const out = transition(state, { type: "wake" }, 10_000 + 11 * MINUTE, ctx)
    const said = out.effects.filter((e) => e.type === "speak").map((e) => (e as { text: string }).text)
    expect(said.length).toBe(1)
    expect(out.state.status).toBe("idle")
    expect(out.state.pendingPlan).toBeUndefined()
  })
})
