import { describe, expect, test } from "bun:test"
import type { PaneSummary } from "../bridge/host"
import type { ParseContext } from "../intent/parse"
import { createInitialDialogState, readingMs, transition, type DialogState } from "./session"
import { answersWithoutName } from "./name-gate"

/*
 * V1-ter, ALTO 4 and the reserve of ALTO 5: the wait for a question to be
 * read held only for permissions out of the queue. A held message promoted
 * after a yes was granted by a «va bene» 600 ms later — the room still
 * answering the first question — and opened the name gate on top. Everything
 * that comes out of the queue now waits to be read, and is answered with the
 * name.
 */

const pane = (id: string, index: number, title: string): PaneSummary => ({
  id, index, title, status: "idle", hasLiveProcess: true, isBrowser: false, isFile: false,
})
const ctx: ParseContext = { panes: [pane("pA", 1, "Alfa")], focusedPaneId: "pA" }
const plan = { steps: [{ action: "send_prompt" as const, paneIndex: 1, text: "esegui i test" }], refusals: [] }

function askedWithQueue(event: Parameters<typeof transition>[1]): DialogState {
  const asked = transition(createInitialDialogState("idle"), { type: "permission_requested", paneId: "pA", what: "cat README" }, 10_000, ctx).state
  return transition(asked, event, 11_000, ctx).state
}

describe("what comes out of the queue waits to be read", () => {
  test("a held message promoted by a yes is not granted by the next «va bene» said over it", () => {
    const queued = askedWithQueue({ type: "send_requested", id: "m1", to: "claude-code", text: "fai push", lead: "Un mittente senza firma vuole avviare una sessione" })
    const promoted = transition(queued, { type: "utterance", text: "sì" }, 20_000, ctx)
    expect(promoted.state.pendingSend?.id).toBe("m1")

    const early = transition(promoted.state, { type: "utterance", text: "va bene" }, 20_600, ctx)
    expect(early.effects.some((e) => e.type === "confirm_send" && e.approved)).toBe(false)
    expect(early.effects.some((e) => e.type === "speak" && e.text.includes("fai push"))).toBe(true)

    const later = early.state.pendingSend?.answerableAt ?? 0
    const read = transition(early.state, { type: "utterance", text: "sì" }, later + 1, ctx)
    expect(read.effects).toContainEqual({ type: "confirm_send", id: "m1", approved: true })
  })

  test("a no to it counts at once", () => {
    const queued = askedWithQueue({ type: "send_requested", id: "m1", to: "Alfa", text: "cancella dist" })
    const promoted = transition(queued, { type: "utterance", text: "sì" }, 20_000, ctx).state
    const no = transition(promoted, { type: "utterance", text: "no" }, 20_300, ctx)
    expect(no.effects).toContainEqual({ type: "confirm_send", id: "m1", approved: false })
  })

  test("a plan promoted by a yes is not run by the next «va bene»", () => {
    const queued = askedWithQueue({ type: "plan_ready", ...plan })
    const promoted = transition(queued, { type: "utterance", text: "sì" }, 20_000, ctx)
    expect(promoted.state.pendingPlan).toBeDefined()

    const early = transition(promoted.state, { type: "utterance", text: "va bene" }, 20_600, ctx)
    expect(early.effects.some((e) => e.type === "execute_plan")).toBe(false)

    const read = transition(early.state, { type: "utterance", text: "sì" }, 20_600 + readingMs("x".repeat(200)) + 1, ctx)
    expect(read.effects.some((e) => e.type === "execute_plan")).toBe(true)
  })

  test("promoted from the queue, a message or a plan is answered with the name", () => {
    const sendQueued = askedWithQueue({ type: "send_requested", id: "m1", to: "Alfa", text: "cancella dist" })
    expect(answersWithoutName(transition(sendQueued, { type: "utterance", text: "sì" }, 20_000, ctx).state, false)).toBe(false)
    const planQueued = askedWithQueue({ type: "plan_ready", ...plan })
    expect(answersWithoutName(transition(planQueued, { type: "utterance", text: "sì" }, 20_000, ctx).state, false)).toBe(false)
  })

  test("asked at once, a message keeps its answer without the name", () => {
    const direct = transition(createInitialDialogState("idle"), { type: "send_requested", id: "m1", to: "Alfa", text: "cancella dist" }, 10_000, ctx).state
    expect(answersWithoutName(direct, false)).toBe(true)
  })
})
