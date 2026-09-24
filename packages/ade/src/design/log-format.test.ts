import { beforeEach, describe, expect, test } from "bun:test"
import { resetLocaleForTests } from "../i18n"
import { parseDesignLog, serializeDesignEvent, toEvent, type DesignEvent, type OpenedDesignEvent } from "./log"

/*
 * The register's new format (polish-aaa, point 3, piece A1): question, why,
 * recommend and keeps on the proposal, changes on each variant, all optional,
 * and lines written before them left exactly as they are.
 */

beforeEach(() => resetLocaleForTests("it"))

/** DS-S62-5 as it is in `.ade/design.jsonl`, written by `ade-msg registro` before the new fields. */
const DS_S62_5 = `{"type":"aperta","k":"DS-S62-5","at":"2026-09-23T00:21:53.696Z","by":"Dario","title":"La Fiala, reiterata: vetro, gesto e livello","context":"Il tuo 'pure questo mi piace ma reiteriamolo' sulla Fiala. Tre variazioni, ognuna spinge un aspetto diverso; il resto resta com'era (materiale dell'orb, colori di Design e Decisioni, riposo vivo a 20 fps, fermo quando non c'e niente). Nella tua ADE di oggi il pannello non esegue gli script delle proposte: aprile in Edge. Si vedranno nel tasto dalla release con S75.","spec":"S62","variants":[{"name":"1 · Vetro","description":"Tubo piu stretto con labbro piu largo, parete di almeno 1 px con il lato destro in ombra, riflesso lungo e menisco che sale sulle pareti. A 20 px resta un tubo.","preview":"C:/Users/39349/Favorites/nikcli/.ade/design/DS-S62-5/1.html"},{"name":"2 · Gesto","description":"La goccia cade stirata, fa cratere, getto e due o tre schizzi. Impatto a 0,20 s invece di 0,44; si posa in 1,3 s invece di 2,25.","preview":"C:/Users/39349/Favorites/nikcli/.ade/design/DS-S62-5/2.html"},{"name":"3 · Livello","description":"Cinque fasce con una riga di luce e cinque tacche sulla parete; oltre cinque compare una cupola. A 26 px le voci si contano.","preview":"C:/Users/39349/Favorites/nikcli/.ade/design/DS-S62-5/3.html"}],"order":62}`

const newFormat = {
  type: "aperta",
  k: "DS-A",
  at: "2026-09-24T10:00:00.000Z",
  by: "Debora",
  title: "La forma della carta della decisione",
  question: "Come vuoi leggere una decisione?",
  why: "Oggi il contesto è un paragrafo solo e la raccomandazione arriva per ultima.",
  context: "Tre forme per la stessa decisione, D79.",
  recommend: { option: "1 · Documento", because: "Si legge dall'alto in basso anche in un pannello stretto." },
  keeps: ["I colori dei temi", "Le scorciatoie da tastiera"],
  spec: "polish-aaa",
  variants: [
    { name: "1 · Documento", description: "Domanda, raccomandazione, perché, opzioni in colonna.", preview: ".ade/design/DS-A/1.html", changes: ["La raccomandazione in alto", "Testo a 13 px"] },
    { name: "2 · Confronto", description: "Opzioni affiancate.", preview: ".ade/design/DS-A/2.html" },
  ],
}

describe("the new format in the design register", () => {
  test("a line written before the new fields stays identical", () => {
    expect(serializeDesignEvent(toEvent(JSON.parse(DS_S62_5)) as DesignEvent)).toBe(`${DS_S62_5}\n`)
    expect(parseDesignLog(DS_S62_5).problems).toEqual([])
  })

  test("a line in the new format survives serialize and a second read", () => {
    const line = serializeDesignEvent(newFormat as DesignEvent)
    const read = parseDesignLog(line)
    expect(read.problems).toEqual([])
    const event = read.events[0] as OpenedDesignEvent
    expect(event.question).toBe(newFormat.question)
    expect(event.why).toBe(newFormat.why)
    expect(event.recommend).toEqual(newFormat.recommend)
    expect(event.keeps).toEqual(newFormat.keeps)
    expect(event.variants).toEqual(newFormat.variants)
    expect(serializeDesignEvent(event)).toBe(line)
  })

  test("a recommendation that is not one of the variants refuses the line", () => {
    expect(toEvent({ ...newFormat, recommend: { option: "3 · Compatta" } })).toBe("la raccomandazione «3 · Compatta» non è una delle varianti")
    expect(toEvent({ ...newFormat, recommend: ["1 · Documento"] })).toBe("recommend vuole { option, because }")
  })

  test("context stays required on a line that uses the new fields: older builds show only that", () => {
    expect(toEvent({ ...newFormat, context: undefined })).toBe(
      "con i campi nuovi serve anche context: le versioni che non li conoscono mostrano solo quello",
    )
  })

  test("changes and keeps must be lists of texts", () => {
    expect(toEvent({ ...newFormat, keeps: "i colori" })).toBe("keeps non è un elenco di testi")
    const variants = [{ ...newFormat.variants[0], changes: [3] }, newFormat.variants[1]]
    expect(toEvent({ ...newFormat, variants })).toBe("changes non è un elenco di testi")
  })
})
