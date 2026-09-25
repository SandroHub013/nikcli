import { describe, expect, test } from "bun:test"
import { submitDraft } from "./composer"

/*
 * B3-bis (review B3, BASSO 3): a message that did not go — a trust question
 * already open, a «no» to it, a bot that refuses to start, a turn still
 * running — used to vanish with the cleared composer.
 */
function field(initial: string) {
  let value = initial
  return { get: () => value, set: (text: string) => void (value = text) }
}

describe("il composer dei bot", () => {
  test("un messaggio partito lascia il composer vuoto", async () => {
    const draft = field("ciao")
    await submitDraft("ciao", () => true, draft)
    expect(draft.get()).toBe("")
  })

  test("un messaggio che non parte torna nel composer", async () => {
    const draft = field("ciao")
    await submitDraft("ciao", async () => false, draft)
    expect(draft.get()).toBe("ciao")
  })

  test("il composer si svuota subito, mentre si aspetta la risposta", async () => {
    const draft = field("ciao")
    let answer: (sent: boolean) => void = () => {}
    const sending = submitDraft("ciao", () => new Promise<boolean>((resolve) => (answer = resolve)), draft)
    expect(draft.get()).toBe("")
    answer(false)
    await sending
    expect(draft.get()).toBe("ciao")
  })

  test("se nel frattempo si è scritto altro, quello non si tocca", async () => {
    const draft = field("ciao")
    let answer: (sent: boolean) => void = () => {}
    const sending = submitDraft("ciao", () => new Promise<boolean>((resolve) => (answer = resolve)), draft)
    draft.set("un'altra cosa")
    answer(false)
    await sending
    expect(draft.get()).toBe("un'altra cosa")
  })

  test("un invio che fallisce con un errore rimette il testo", async () => {
    const draft = field("ciao")
    await submitDraft("ciao", async () => {
      throw new Error("host sparito")
    }, draft)
    expect(draft.get()).toBe("ciao")
  })
})
