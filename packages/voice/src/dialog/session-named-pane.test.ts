import { describe, expect, test } from "bun:test"
import type { PaneSummary } from "../bridge/host"
import type { ParseContext } from "../intent/parse"
import { createInitialDialogState, transition, type DialogState } from "./session"

/*
 * V1-bis, ALTO 2: while the permission of pane A was asked, «consenti pannello
 * 2» or «autorizza beta» granted A. A named pane is the pane acted on: the one
 * being asked is answered; another one with a request waiting has its own
 * question asked, and nothing is granted without it.
 */

const pane = (id: string, index: number, title: string): PaneSummary => ({
  id, index, title, status: "idle", hasLiveProcess: true, isBrowser: false, isFile: false,
})
const ctx: ParseContext = { panes: [pane("pA", 1, "Alfa"), pane("pB", 2, "Beta"), pane("pC", 3, "Gamma")], focusedPaneId: "pA" }

/** A asked, B waiting behind it. */
function askingAWithBQueued(): DialogState {
  const s1 = transition(createInitialDialogState("idle"), { type: "permission_requested", paneId: "pA", what: "cat README" }, 10_000, ctx).state
  return transition(s1, { type: "permission_requested", paneId: "pB", what: "rm -rf build" }, 11_000, ctx).state
}
const say = (state: DialogState, text: string, now = 30_000) => transition(state, { type: "utterance", text }, now, ctx)
const answers = (effects: { type: string }[]) =>
  effects.filter((e): e is { type: "answer_permission"; paneId: string; answer: "allow" | "deny" } => e.type === "answer_permission")

describe("a named pane is the pane acted on", () => {
  test("«consenti pannello 2» does not grant A: B's own question is asked", () => {
    const { state, effects } = say(askingAWithBQueued(), "consenti pannello 2")
    expect(answers(effects)).toEqual([])
    expect(state.status).toBe("confirming")
    expect(state.pendingAction?.paneId).toBe("pB")
    expect(effects.some((e) => e.type === "speak" && e.text.includes("rm -rf build"))).toBe(true)
    // A is not lost: it waits for its turn.
    expect(state.queuedPermission?.paneId).toBe("pA")
  })

  test("«autorizza beta» is the same", () => {
    const { state, effects } = say(askingAWithBQueued(), "autorizza beta")
    expect(answers(effects)).toEqual([])
    expect(state.pendingAction?.paneId).toBe("pB")
  })

  test("naming the pane being asked answers it", () => {
    const granted = answers(say(askingAWithBQueued(), "consenti pannello 1").effects)
    expect(granted.map(({ paneId, answer }) => ({ paneId, answer }))).toEqual([{ paneId: "pA", answer: "allow" }])
  })

  test("a pane with nothing asked grants nothing and says so", () => {
    const { state, effects } = say(askingAWithBQueued(), "consenti pannello 3")
    expect(answers(effects)).toEqual([])
    expect(state.pendingAction?.paneId).toBe("pA")
    expect(effects.some((e) => e.type === "speak" && e.text.includes("Gamma"))).toBe(true)
  })

  test("«nega pannello 2» does not deny A either", () => {
    const { state, effects } = say(askingAWithBQueued(), "nega pannello 2")
    expect(answers(effects)).toEqual([])
    expect(state.pendingAction?.paneId).toBe("pB")
  })
})
