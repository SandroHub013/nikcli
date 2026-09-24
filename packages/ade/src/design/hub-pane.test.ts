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
  test("a line is added below a note already written, which stays as it was", () => {
    const h = hub()
    h.setDraft("DS-A", { note: "La 2 mi piace.", picked: 1 })
    h.addNoteLine("DS-A", "Variante 2 «Vetro» · h1 «Titolo»: più grande")
    expect(h.draft("DS-A")).toEqual({ note: "La 2 mi piace.\nVariante 2 «Vetro» · h1 «Titolo»: più grande", picked: 1 })
  })

  test("two lines in a row do not merge", () => {
    const h = hub()
    h.addNoteLine("DS-A", "uno")
    h.addNoteLine("DS-A", "due")
    expect(h.draft("DS-A").note.split("\n")).toEqual(["uno", "due"])
  })

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
