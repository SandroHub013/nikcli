import { describe, expect, test } from "bun:test"
import { effortChange, modelChange, runnerModelItems, submitDraft } from "./composer"

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
    await submitDraft(
      "ciao",
      async () => {
        throw new Error("host sparito")
      },
      draft,
    )
    expect(draft.get()).toBe("ciao")
  })
})

/*
 * Composer-chip, pezzo 4: the model and effort chips under the bot's field
 * change the bot. What each choice writes, as `updateBot` takes it: a key
 * set to undefined clears, a key left out is left alone.
 */
describe("i chip del composer dei bot", () => {
  test("un modello scelto si scrive; il predefinito toglie il modello", () => {
    expect(modelChange("openrouter/google/gemma-4-31b-it:free", "", undefined)).toEqual({
      model: "openrouter/google/gemma-4-31b-it:free",
    })
    const cleared = modelChange("", "", undefined)
    expect("model" in cleared).toBe(true)
    expect(cleared.model).toBeUndefined()
  })

  test("uno sforzo che il nuovo modello non ha se ne va con lui, come nel modulo", () => {
    const change = modelChange("opencode/big-pickle", "high", ["none", "thinking"])
    expect("effort" in change).toBe(true)
    expect(change.effort).toBeUndefined()
  })

  test("uno sforzo che il nuovo modello ha, o livelli non noti, lasciano lo sforzo com'è", () => {
    expect("effort" in modelChange("opencode/big-pickle", "thinking", ["none", "thinking"])).toBe(false)
    expect("effort" in modelChange("sonnet", "high", undefined)).toBe(false)
    expect("effort" in modelChange("opencode/big-pickle", "", ["none"])).toBe(false)
  })

  test("lo sforzo scelto si scrive; il predefinito lo toglie", () => {
    expect(effortChange("thinking")).toEqual({ effort: "thinking" })
    const cleared = effortChange("")
    expect("effort" in cleared).toBe(true)
    expect(cleared.effort).toBeUndefined()
  })

  test("per Claude Code e Codex: il predefinito, i nomi del runner, e il nome del bot se la lista non lo ha", () => {
    const values = (items: ReturnType<typeof runnerModelItems>) =>
      items.map((item) => (item.kind === "option" ? item.value : ""))
    expect(values(runnerModelItems(["sonnet", "opus"], "", "predefinito"))).toEqual(["", "sonnet", "opus"])
    expect(values(runnerModelItems(["sonnet", "opus"], "claude-sonnet-5", "predefinito"))).toEqual([
      "",
      "sonnet",
      "opus",
      "claude-sonnet-5",
    ])
    expect(values(runnerModelItems(["sonnet", "opus"], "opus", "predefinito"))).toEqual(["", "sonnet", "opus"])
    expect(runnerModelItems([], "", "predefinito di Codex")[0]).toEqual({
      kind: "option",
      value: "",
      label: "predefinito di Codex",
    })
  })
})
