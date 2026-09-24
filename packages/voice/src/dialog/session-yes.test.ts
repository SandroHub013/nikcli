import { describe, expect, test } from "bun:test"
import type { PaneSummary } from "../bridge/host"
import type { ParseContext } from "../intent/parse"
import { createInitialDialogState, transition, type DialogState } from "./session"

/*
 * V1-bis, ALTO 1 (voice-v1-giudizio): a yes with words added confirmed.
 * «sì però aspetta», «va bene, anzi», «confermo dopo», «va bene la cena»
 * closed the pane or granted the permission. Only a small closed set of
 * yeses confirms; «ma», «però», «anzi», «dopo», «aspetta», «stop» veto; the
 * rest confirms nothing.
 */

const pane = (id: string, index: number, title: string): PaneSummary => ({
  id, index, title, status: "idle", hasLiveProcess: true, isBrowser: false, isFile: false,
})
const panes = [pane("pA", 1, "Alfa"), pane("pB", 2, "Beta")]
const ctx: ParseContext = { panes, focusedPaneId: "pA" }

function askingToClose(): DialogState {
  return transition(createInitialDialogState("idle"), { type: "utterance", text: "chiudi il pannello" }, 10_000, ctx).state
}
function askingPermission(): DialogState {
  return transition(createInitialDialogState("idle"), { type: "permission_requested", paneId: "pA", what: "rm -rf build" }, 10_000, ctx).state
}
const say = (state: DialogState, text: string) => transition(state, { type: "utterance", text }, 20_000, ctx)
const acted = (effects: { type: string }[]) => effects.some((e) => e.type === "execute_intent")
const granted = (effects: { type: string; answer?: string }[]) => effects.some((e) => e.type === "answer_permission" && e.answer === "allow")
const denied = (effects: { type: string; answer?: string }[]) => effects.some((e) => e.type === "answer_permission" && e.answer === "deny")

describe("a yes is only a yes", () => {
  for (const text of ["sì", "si", "confermo", "va bene", "procedi", "certo", "ok", "sì sì", "sì, va bene"]) {
    test(`«${text}» confirms`, () => {
      expect(acted(say(askingToClose(), text).effects)).toBe(true)
      expect(granted(say(askingPermission(), text).effects)).toBe(true)
    })
  }

  for (const text of ["sì però aspetta", "va bene, anzi", "confermo dopo", "va bene ma dopo", "sì ma aspetta", "ok stop"]) {
    test(`«${text}» is a veto`, () => {
      const closing = say(askingToClose(), text)
      expect(acted(closing.effects)).toBe(false)
      expect(closing.state.status).toBe("idle")
      const permission = say(askingPermission(), text)
      expect(granted(permission.effects)).toBe(false)
      expect(denied(permission.effects)).toBe(true)
    })
  }

  for (const text of ["va bene la cena", "procedi pure con calma", "sì certo che piove"]) {
    test(`«${text}» confirms nothing and asks again`, () => {
      const closing = say(askingToClose(), text)
      expect(acted(closing.effects)).toBe(false)
      expect(closing.state.status).toBe("confirming")
      const permission = say(askingPermission(), text)
      expect(granted(permission.effects)).toBe(false)
      expect(permission.state.status).toBe("confirming")
    })
  }
})
