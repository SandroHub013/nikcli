import { describe, expect, test } from "bun:test"
import type { PaneSummary } from "../bridge/host"
import type { ParseContext } from "../intent/parse"
import { createInitialDialogState, transition, type DialogState } from "./session"
import { answersWithoutName } from "./name-gate"

/*
 * V1-ter, ALTO 3: «consenti» said with no question in course asked «Concedo il
 * permesso all'agente, va bene?» and, on the yes, answered whatever the pane
 * was asking by then — a «rm -rf ~» that arrived after the first request was
 * answered by hand. The question now names what it grants, takes it from the
 * request open at that moment, and grants that one only.
 */

const pane = (id: string, index: number, title: string): PaneSummary => ({
  id, index, title, status: "idle", hasLiveProcess: true, isBrowser: false, isFile: false,
})
let open: Record<string, string> = {}
const ctx: ParseContext = {
  panes: [pane("pA", 1, "Alfa"), pane("pB", 2, "Beta")],
  focusedPaneId: "pA",
  permissionWhat: (paneId) => open[paneId],
}
const say = (state: DialogState, text: string, now = 30_000) => transition(state, { type: "utterance", text }, now, ctx)

describe("«consenti» from idle grants the request it named", () => {
  test("the question names the pane and the command, and the grant carries it", () => {
    open = { pA: "cat README" }
    const asked = say(createInitialDialogState("idle"), "consenti", 10_000)
    expect(asked.state.status).toBe("confirming")
    expect(asked.effects.some((e) => e.type === "speak" && e.text.includes("Alfa") && e.text.includes("cat README"))).toBe(true)
    const yes = say(asked.state, "sì")
    expect(yes.effects).toContainEqual({ type: "answer_permission", paneId: "pA", answer: "allow", what: "cat README" })
  })

  test("answered by hand meanwhile: the question leaves, and the next request is not granted by that yes", () => {
    open = { pA: "cat README" }
    const asked = say(createInitialDialogState("idle"), "consenti", 10_000).state
    const resolved = transition(asked, { type: "permission_resolved", paneId: "pA" }, 11_000, ctx).state
    open = { pA: "rm -rf ~" }
    const next = transition(resolved, { type: "permission_requested", paneId: "pA", what: "rm -rf ~" }, 12_000, ctx).state
    const yes = say(next, "sì", 12_300)
    expect(yes.effects.some((e) => e.type === "answer_permission" && e.answer === "allow" && e.what !== "rm -rf ~")).toBe(false)
    // Nor through the intent road, which answered whatever was pending without saying what.
    expect(yes.effects.some((e) => e.type === "execute_intent")).toBe(false)
  })

  test("a pane with nothing asked: said at once, nothing to confirm", () => {
    open = {}
    const asked = say(createInitialDialogState("idle"), "consenti pannello 2", 10_000)
    expect(asked.state.status).toBe("idle")
    expect(asked.effects.some((e) => e.type === "speak" && e.text.includes("Beta"))).toBe(true)
  })

  test("asked by the user, its answer needs no name", () => {
    open = { pA: "cat README" }
    const asked = say(createInitialDialogState("idle"), "consenti", 10_000).state
    expect(answersWithoutName(asked, false)).toBe(true)
  })
})
