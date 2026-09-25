import { describe, expect, test } from "bun:test"
import type { PaneSummary } from "../bridge/host"
import type { ParseContext } from "../intent/parse"
import { createInitialDialogState, transition } from "./session"

/*
 * V1-ter, reserve of ALTO 8: a third request, while one was being asked and
 * one waited, was dropped yet announced as «in coda», and its `ade-msg` never
 * got an answer. It is refused, and the sender is told.
 */

const pane = (id: string, index: number, title: string): PaneSummary => ({
  id, index, title, status: "idle", hasLiveProcess: true, isBrowser: false, isFile: false,
})
const ctx: ParseContext = { panes: [pane("pA", 1, "Alfa")], focusedPaneId: "pA" }

describe("a third held message is refused, not lost", () => {
  test("a third request, with one asked and one in line, is refused and said so", () => {
    let state = createInitialDialogState("idle")
    state = transition(state, { type: "send_requested", id: "m1", to: "Alfa", text: "uno" }, 10_000, ctx).state
    state = transition(state, { type: "send_requested", id: "m2", to: "Alfa", text: "due" }, 10_100, ctx).state
    const third = transition(state, { type: "send_requested", id: "m3", to: "Beta", text: "tre" }, 10_200, ctx)

    expect(third.effects).toContainEqual({ type: "confirm_send", id: "m3", approved: false })
    expect(third.effects.some((e) => e.type === "speak" && e.text.includes("in coda") && !e.text.includes("non"))).toBe(false)
    expect(third.state.pendingSend?.id).toBe("m1")
    expect(third.state.queuedSend?.id).toBe("m2")
  })
})

const plan = (text: string) => ({
  steps: [{ action: "send_prompt" as const, paneIndex: 1, text }],
  refusals: [] as string[],
})

describe("a second plan waiting is refused, not lost", () => {
  test("P2, with P1 in line, is refused and said so; P1 is still asked and still runs", () => {
    const asked = transition(createInitialDialogState("idle"), { type: "permission_requested", paneId: "pA", what: "cat README" }, 10_000, ctx).state
    const p1 = transition(asked, { type: "plan_ready", ...plan("primo") }, 10_100, ctx).state
    const refused = transition(p1, { type: "plan_ready", ...plan("secondo") }, 10_200, ctx)

    expect(
      refused.effects.some((e) => e.type === "speak" && e.text === "Ho già un piano in coda: non chiedo il nuovo, chiedo il primo."),
    ).toBe(true)
    expect(refused.effects.some((e) => e.type === "speak" && e.text.includes("in coda") && !e.text.includes("non"))).toBe(false)
    expect(refused.state.queuedPlan?.steps).toEqual(plan("primo").steps)

    const promoted = transition(refused.state, { type: "utterance", text: "sì" }, 20_000, ctx)
    expect(promoted.state.pendingPlan?.steps).toEqual(plan("primo").steps)

    const run = transition(promoted.state, { type: "utterance", text: "sì" }, 40_000, ctx)
    expect(run.effects).toContainEqual({ type: "execute_plan", steps: plan("primo").steps, refusals: [] })
  })
})
