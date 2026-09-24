import { beforeEach, describe, expect, test } from "bun:test"
import { resetLocaleForTests } from "../i18n"
import { parseDecisionLog, serializeDecisionEvent, toEvent, type DecisionEvent, type OpenedEvent } from "./log"

/*
 * The register's new format (polish-aaa, point 3, piece A1): question, why,
 * facts, recommend and options with title/effect/cost/risk, all optional, and
 * lines written before them left exactly as they are.
 */

beforeEach(() => resetLocaleForTests("it"))

/** D79 as it is in `.ade/decisions.jsonl`, written by `ade-msg registro` before the new fields. */
const D79 = `{"type":"aperta","k":"D79","at":"2026-09-23T11:10:01.304Z","by":"Master","title":"ADE piu leggera: sospendere le sessioni Claude ferme?","context":"Le misure di P1 dicono che dei circa 3 GB che vedi con ADE in uso, circa l'80% non e ADE: sono le sessioni Claude aperte, circa 800 MB l'una con i loro server MCP, anche quando sono ferme al prompt. ADE da sola pesa circa 650 MB. Le altre correzioni (ADE ferma da minimizzata, cursore, piper, stampa pesante) tolgono processore e un centinaio di MB; il guadagno grosso di memoria e solo qui. ADE conserva gia l'id per riprendere ogni sessione Claude (resumeId), quindi puo chiudere il processo e riaprirlo dopo con la stessa conversazione. Cosa cambia per te: una sessione sospesa riparte in qualche secondo quando la riapri, e il primo messaggio dopo la ripresa rilegge la conversazione. Vale solo per le sessioni Claude; agy, nikcli e opencode restano come sono. Raccomandazione di Master: B. Con C una sessione della squadra che aspetta un messaggio verrebbe chiusa, e la consegna dovrebbe risvegliarla: si puo fare, ma e un secondo passo, da fare solo dopo che B ha funzionato.","options":[{"label":"A","detail":"Niente: le sessioni restano vive come oggi. Nessun rischio, nessun guadagno di memoria."},{"label":"B","detail":"Sospensione su richiesta: un comando 'Sospendi' sul pannello di una sessione Claude ferma. Il pannello resta al suo posto con 'Riprendi'. Circa 800 MB liberati per ogni sessione sospesa. (consigliata)"},{"label":"C","detail":"Come B, piu sospensione automatica dopo N minuti di inattivita (proposta: 30), mai con un permesso in attesa, una richiesta aperta o la sessione al lavoro. I messaggi ade-msg la risvegliano. Guadagno massimo, ma cambia il comportamento della squadra."}],"unlocks":"P1 C6: memoria delle sessioni ferme","spec":"P1-C6","order":79}`

const newFormat = {
  type: "aperta",
  k: "D90",
  at: "2026-09-24T10:00:00.000Z",
  by: "Master",
  title: "Sospendere le sessioni Claude ferme?",
  question: "Sospendere le sessioni Claude ferme per liberare memoria?",
  why: "Dei ~3 GB di ADE in uso, l'80% sono sessioni Claude ferme: ~800 MB l'una.",
  context: "Una sessione sospesa riparte in qualche secondo quando la riapri.",
  facts: ["ADE da sola: ~650 MB", "Ogni sessione ha già il suo resumeId"],
  recommend: { option: "B", because: "C cambia il comportamento della squadra: dopo che B ha funzionato." },
  options: [
    { label: "A", title: "Niente", effect: "Le sessioni restano vive come oggi" },
    { label: "B", title: "Sospendi su richiesta", detail: "Un comando sul pannello.", effect: "Riparte in qualche secondo quando la riapri", cost: "1 consegna, ~1 giorno", risk: "basso" },
  ],
  spec: "P1-C6",
}

describe("the new format in the decisions register", () => {
  test("a line written before the new fields stays identical", () => {
    expect(serializeDecisionEvent(toEvent(JSON.parse(D79)) as DecisionEvent)).toBe(`${D79}\n`)
    expect(parseDecisionLog(D79).problems).toEqual([])
  })

  test("a line in the new format survives serialize and a second read", () => {
    const line = serializeDecisionEvent(newFormat as DecisionEvent)
    const read = parseDecisionLog(line)
    expect(read.problems).toEqual([])
    const event = read.events[0] as OpenedEvent
    expect(event.question).toBe(newFormat.question)
    expect(event.why).toBe(newFormat.why)
    expect(event.facts).toEqual(newFormat.facts)
    expect(event.recommend).toEqual(newFormat.recommend)
    expect(event.options).toEqual(newFormat.options)
    expect(serializeDecisionEvent(event)).toBe(line)
  })

  test("a recommendation that is not one of the options refuses the line", () => {
    expect(toEvent({ ...newFormat, recommend: { option: "D" } })).toBe("la raccomandazione «D» non è una delle opzioni")
    // Without options there is nothing to recommend.
    expect(toEvent({ ...newFormat, options: undefined, recommend: { option: "B" } })).toBe("la raccomandazione «B» non è una delle opzioni")
    expect(toEvent({ ...newFormat, recommend: "B" })).toBe("recommend vuole { option, because }")
    expect(toEvent({ ...newFormat, recommend: { because: "così" } })).toBe("recommend vuole { option, because }")
  })

  test("context stays required on a line that uses the new fields: older builds show only that", () => {
    expect(toEvent({ ...newFormat, context: undefined })).toBe(
      "con i campi nuovi serve anche context: le versioni che non li conoscono mostrano solo quello",
    )
    // A line in the old format keeps its old rule: context was never required there.
    const plain = { type: "aperta", k: "D91", at: newFormat.at, by: "Master", title: "Senza contesto", options: [{ label: "A" }, { label: "B" }] }
    expect(typeof toEvent(plain)).toBe("object")
  })

  test("facts must be a list of texts; empty fields are dropped", () => {
    expect(toEvent({ ...newFormat, facts: "ADE da sola: ~650 MB" })).toBe("facts non è un elenco di testi")
    expect(toEvent({ ...newFormat, facts: ["uno", ""] })).toBe("facts non è un elenco di testi")
    const event = toEvent({ ...newFormat, facts: [], question: "  ", recommend: { option: "B", because: " " } }) as OpenedEvent
    expect("facts" in event).toBe(false)
    expect("question" in event).toBe(false)
    expect(event.recommend).toEqual({ option: "B" })
  })
})
