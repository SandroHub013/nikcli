import { describe, expect, test } from "bun:test"
import type { PaneSummary } from "../bridge/host"
import type { ParseContext } from "../intent/parse"
import { createInitialDialogState, transition, type DialogState } from "./session"

/*
 * V1-bis, ALTO 3: a yes said to «cat README» granted the «rm -rf ~» asked
 * next by the same pane, once the first was answered by hand. The yes is for
 * the request whose question was read: it carries what was asked, the host
 * checks it, a request closed elsewhere leaves the dialogue
 * (`permission_resolved`, declared and never handled), and a new request of
 * the same pane replaces the question instead of queueing behind it.
 */

const pane = (id: string, index: number, title: string): PaneSummary => ({
  id, index, title, status: "idle", hasLiveProcess: true, isBrowser: false, isFile: false,
})
const ctx: ParseContext = { panes: [pane("pA", 1, "Alfa"), pane("pB", 2, "Beta")], focusedPaneId: "pA" }
const ask = (state: DialogState, paneId: string, what: string, now = 10_000) =>
  transition(state, { type: "permission_requested", paneId, what }, now, ctx)
const say = (state: DialogState, text: string) => transition(state, { type: "utterance", text }, 30_000, ctx)

describe("a yes is for the question that was read", () => {
  test("the grant names what it grants", () => {
    const asked = ask(createInitialDialogState("idle"), "pA", "cat README").state
    const granted = say(asked, "sì").effects.find((e) => e.type === "answer_permission")
    expect(granted).toEqual({ type: "answer_permission", paneId: "pA", answer: "allow", what: "cat README" })
  })

  test("answered by hand: the question leaves, and a later yes grants nothing", () => {
    const asked = ask(createInitialDialogState("idle"), "pA", "cat README").state
    const resolved = transition(asked, { type: "permission_resolved", paneId: "pA" }, 12_000, ctx)
    expect(resolved.state.status).toBe("idle")
    expect(resolved.state.pendingAction).toBeUndefined()
    expect(resolved.effects.some((e) => e.type === "cancel_timer")).toBe(true)
    expect(say(resolved.state, "sì").effects.some((e) => e.type === "answer_permission")).toBe(false)
  })

  test("a new request of the same pane replaces the question: the yes goes to what was just read", () => {
    const first = ask(createInitialDialogState("idle"), "pA", "cat README").state
    const second = ask(first, "pA", "rm -rf ~", 12_000)
    expect(second.state.queuedPermission).toBeUndefined()
    expect(second.state.pendingAction?.what).toBe("rm -rf ~")
    expect(second.effects.some((e) => e.type === "speak" && e.text.includes("rm -rf ~"))).toBe(true)
  })

  test("a queued request closed elsewhere leaves the queue", () => {
    const asked = ask(ask(createInitialDialogState("idle"), "pA", "cat README").state, "pB", "npm publish", 11_000).state
    expect(asked.queuedPermission?.paneId).toBe("pB")
    const resolved = transition(asked, { type: "permission_resolved", paneId: "pB" }, 12_000, ctx)
    expect(resolved.state.queuedPermission).toBeUndefined()
    expect(resolved.state.pendingAction?.paneId).toBe("pA")
  })

  test("a queued request replaced by a newer one of the same pane keeps the newer", () => {
    const asked = ask(ask(ask(createInitialDialogState("idle"), "pA", "cat README").state, "pB", "ls", 11_000).state, "pB", "rm -rf /", 11_500).state
    expect(asked.queuedPermission).toEqual({ paneId: "pB", what: "rm -rf /", silent: undefined })
  })
})
