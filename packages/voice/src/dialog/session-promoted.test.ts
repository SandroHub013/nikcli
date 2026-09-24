import { describe, expect, test } from "bun:test"
import type { PaneSummary } from "../bridge/host"
import type { ParseContext } from "../intent/parse"
import { createInitialDialogState, transition, type DialogState } from "./session"

/*
 * V1-bis, ALTO 4: «sì» and «va bene» said one after the other granted A and
 * then B, promoted from the queue by the first yes, whose question the second
 * cut short: B was granted without being heard. A promoted request is
 * answerable once its question has been read whole.
 */

const pane = (id: string, index: number, title: string): PaneSummary => ({
  id, index, title, status: "idle", hasLiveProcess: true, isBrowser: false, isFile: false,
})
const ctx: ParseContext = { panes: [pane("pA", 1, "Alfa"), pane("pB", 2, "Beta")], focusedPaneId: "pA" }
const say = (state: DialogState, text: string, now: number) => transition(state, { type: "utterance", text }, now, ctx)
const grants = (effects: { type: string; answer?: string; paneId?: string }[]) =>
  effects.filter((e) => e.type === "answer_permission" && e.answer === "allow").map((e) => e.paneId)

function aAskedBQueued(): DialogState {
  const s1 = transition(createInitialDialogState("idle"), { type: "permission_requested", paneId: "pA", what: "ls" }, 10_000, ctx).state
  return transition(s1, { type: "permission_requested", paneId: "pB", what: "rm -rf /" }, 11_000, ctx).state
}

describe("a promoted question is heard before it is answered", () => {
  test("«sì» then «va bene» at once: A granted, B not; B's question read again", () => {
    const first = say(aAskedBQueued(), "sì", 20_000)
    expect(grants(first.effects)).toEqual(["pA"])
    expect(first.state.pendingAction?.paneId).toBe("pB")
    const second = say(first.state, "va bene", 20_600)
    expect(grants(second.effects)).toEqual([])
    expect(second.state.pendingAction?.paneId).toBe("pB")
    expect(second.effects.some((e) => e.type === "speak" && e.text.includes("rm -rf /"))).toBe(true)
  })

  test("a yes after the question was read grants it", () => {
    const first = say(aAskedBQueued(), "sì", 20_000)
    expect(grants(say(first.state, "sì", 40_000).effects)).toEqual(["pB"])
  })

  test("a no is taken at once", () => {
    const first = say(aAskedBQueued(), "sì", 20_000)
    const refused = say(first.state, "no", 20_300)
    expect(refused.effects.some((e) => e.type === "answer_permission" && e.answer === "deny")).toBe(true)
  })
})
