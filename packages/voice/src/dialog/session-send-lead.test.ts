import { expect, test } from "bun:test"
import { createInitialDialogState, transition } from "./session"

/* V1-bis, ALTO 8: an ask, a spawn or an unproven sender is asked out loud as what it is. */
test("the held message is asked as what it does, and by whom", () => {
  const asked = transition(createInitialDialogState("idle"), { type: "send_requested", id: "m1", to: "Alfa", text: "cancella dist", lead: "La voce vuole chiedere a" }, 10_000)
  expect(asked.state.status).toBe("confirming")
  expect(asked.effects).toContainEqual({ type: "speak", text: "La voce vuole chiedere a «Alfa»: «cancella dist». Confermi?" })
  const stop = transition(createInitialDialogState("idle"), { type: "send_requested", id: "m2", to: "Beta", text: "", lead: "La voce vuole interrompere" }, 10_000)
  expect(stop.effects).toContainEqual({ type: "speak", text: "La voce vuole interrompere «Beta». Confermi?" })
})
