import { describe, expect, test } from "bun:test"
import type { PaneSummary } from "../bridge/host"
import type { ParseContext } from "../intent/parse"
import { transition, type DialogState } from "./session"

/*
 * V1-bis, ALTO 7: the voice agent's turn wrote idle over the confirmation of
 * its own `send`, and the note stayed pending. Later «chiudi il pannello» +
 * «sì» delivered the note and did not close the pane. A note whose question
 * is no longer the one asked is refused, never delivered by another yes.
 */

const pane = (id: string, index: number, title: string): PaneSummary => ({
  id, index, title, status: "idle", hasLiveProcess: true, isBrowser: false, isFile: false,
})
const ctx: ParseContext = { panes: [pane("pA", 1, "Alfa")], focusedPaneId: "pA" }
const stale: DialogState = { status: "idle", pendingSend: { id: "m1", to: "Alfa", text: "cancella dist" } }

describe("a stale note is refused, not delivered", () => {
  test("«chiudi il pannello» then «sì» closes the pane; the note is refused", () => {
    const asked = transition(stale, { type: "utterance", text: "chiudi il pannello" }, 10_000, ctx)
    expect(asked.effects).toContainEqual({ type: "confirm_send", id: "m1", approved: false })
    expect(asked.state.pendingSend).toBeUndefined()
    const yes = transition(asked.state, { type: "utterance", text: "sì" }, 12_000, ctx)
    expect(yes.effects.some((e) => e.type === "confirm_send" && e.approved)).toBe(false)
    expect(yes.effects.some((e) => e.type === "execute_intent" && e.intent.intent === "pane.close")).toBe(true)
  })

  test("a permission asked after it gets the yes", () => {
    const asked = transition(stale, { type: "permission_requested", paneId: "pA", what: "ls" }, 10_000, ctx)
    const yes = transition(asked.state, { type: "utterance", text: "sì" }, 30_000, ctx)
    expect(yes.effects.some((e) => e.type === "confirm_send" && e.approved)).toBe(false)
    expect(yes.effects.some((e) => e.type === "answer_permission" && e.answer === "allow")).toBe(true)
  })
})
