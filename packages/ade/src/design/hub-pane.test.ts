import { describe, expect, test } from "bun:test"
import { createDesignHub } from "./hub"
import { togglePick } from "./answer"
import type { DesignRegister } from "./register"

/*
 * D2: the browser pane in Design mode writes into the same draft as the card.
 * «Aggiungi alla nota» adds a line without touching the note; «Scelgo questa»
 * picks exactly as the card does.
 */

function hub() {
  const register = {
    path: () => "C:/p/.ade/design.jsonl",
    loaded: () => undefined,
    state: () => undefined,
    error: () => undefined,
  } as unknown as DesignRegister
  return createDesignHub({
    register,
    recipient: () => ({ state: "none" }) as never,
    sessions: () => [],
    choose: () => {},
    delivery: () => ({ state: "nessuna" }) as never,
    onAnswered: () => {},
  })
}

describe("the pane writes into the card's draft", () => {
  test("«Scelgo questa» and the card give the same picked, single and multi", () => {
    for (const multi of [false, true]) {
      const h = hub()
      const proposal = { k: "DS-A", ...(multi ? { multi: true as const } : {}) }
      let card: ReturnType<typeof togglePick> | undefined
      for (const index of [1, 2, 1, 0]) {
        h.pick(proposal, index)
        card = togglePick(card, index, multi)
        expect(h.draft("DS-A").picked).toEqual(card)
      }
    }
  })
})
