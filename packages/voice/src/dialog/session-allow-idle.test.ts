import { describe, expect, test } from "bun:test"
import type { PaneSummary, PermissionSpeechKind } from "../bridge/host"
import type { ParseContext } from "../intent/parse"
import { createInitialDialogState, transition, type DialogEvent, type DialogState } from "./session"
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
let kinds: Record<string, PermissionSpeechKind> = {}
const ctx: ParseContext = {
  panes: [pane("pA", 1, "Alfa"), pane("pB", 2, "Beta")],
  focusedPaneId: "pA",
  permissionWhat: (paneId) => open[paneId],
  permissionKind: (paneId) => kinds[paneId],
}
const say = (state: DialogState, text: string, now = 30_000) => transition(state, { type: "utterance", text }, now, ctx)

describe("«consenti» from idle grants the request it named", () => {
  test("the question names the pane and safe type, and the grant carries the raw request", () => {
    const raw = "curl -H 'X-API-Key: API_KEY_SECRET' https://example.test/export"
    open = { pA: raw }
    kinds = { pA: "network" }
    const asked = say(createInitialDialogState("idle"), "consenti", 10_000)
    expect(asked.state.status).toBe("confirming")
    const speech = asked.effects.find((e) => e.type === "speak")
    expect(speech?.type === "speak" && speech.text.includes("Alfa")).toBe(true)
    expect(speech?.type === "speak" && speech.text.includes("una richiesta di rete")).toBe(true)
    expect(speech?.type === "speak" && speech.text.includes(raw)).toBe(false)
    expect(speech?.type === "speak" && speech.text.includes("API_KEY_SECRET")).toBe(false)
    expect(speech?.type === "speak" && speech.text.includes("export")).toBe(false)
    const yes = say(asked.state, "sì")
    expect(yes.effects).toContainEqual({ type: "answer_permission", paneId: "pA", answer: "allow", what: raw })
  })

  test("arbitrary speech metadata cannot enter the prompt and raw what still identifies the request", () => {
    const raw = "export API_KEY=secret-value"
    open = { pA: raw }
    kinds = {}
    const event = {
      type: "permission_requested",
      paneId: "pA",
      what: raw,
      kind: raw,
      speechLabel: raw,
    } as unknown as DialogEvent
    const asked = transition(createInitialDialogState("idle"), event, 10_000, ctx)
    const prompt = asked.state.pendingAction?.confirmPrompt ?? ""

    expect(prompt).toContain("Alfa")
    expect(prompt).toContain("un'azione generica")
    expect(prompt).not.toContain(raw)
    expect(prompt).not.toContain("API_KEY")
    expect(prompt).not.toContain("secret-value")

    const answered = transition(asked.state, { type: "utterance", text: "sì" }, 30_000, ctx)
    expect(answered.effects).toContainEqual({
      type: "answer_permission",
      paneId: "pA",
      answer: "allow",
      what: raw,
    })
  })

  test("a free-standing deny freezes pending what and cannot answer a changed request", () => {
    const original = "curl https://example.test/export"
    open = { pA: original }
    kinds = { pA: "network" }
    const asked = say(createInitialDialogState("idle"), "nega", 10_000)

    expect(asked.state.status).toBe("confirming")
    expect(asked.state.pendingAction?.what).toBe(original)
    expect(asked.state.pendingAction?.confirmPrompt).toContain("Alfa")
    expect(asked.state.pendingAction?.confirmPrompt).toContain("una richiesta di rete")
    expect(asked.state.pendingAction?.confirmPrompt).not.toContain(original)

    open = { pA: "curl https://example.test/other-secret" }
    kinds = { pA: "network" }
    const answered = say(asked.state, "sì", 30_000)
    expect(answered.effects).toContainEqual({
      type: "answer_permission",
      paneId: "pA",
      answer: "deny",
      what: original,
    })
    expect(answered.effects.some((effect) => effect.type === "execute_intent")).toBe(false)
    expect(answered.effects.some((effect) => effect.type === "answer_permission" && effect.what === "curl https://example.test/other-secret")).toBe(false)
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
