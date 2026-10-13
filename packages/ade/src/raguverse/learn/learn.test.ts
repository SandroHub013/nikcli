if (typeof document === "undefined") {
  const { GlobalRegistrator } = await import("@happy-dom/global-registrator")
  GlobalRegistrator.register()
}

import { describe, expect, mock, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  HELLO,
  MAX_INTERVAL,
  PORT_OFFER,
  addDays,
  boot,
  checkAnswer,
  dueReview,
  emptyProgress,
  exerciseKey,
  isProgress,
  levelFor,
  nextInterval,
  normalizeProgress,
  readNonce,
  readPlace,
  recordAnswer,
  rich,
  seedOf,
  shuffle,
  streak,
  xpFor,
} from "./page/learn.js"

if (typeof document === "undefined") {
  const { GlobalRegistrator } = await import("@happy-dom/global-registrator")
  GlobalRegistrator.register()
}

/**
 * The engine of «Impara», run without a page, the way `world.test.ts` runs the world's.
 *
 * The lessons are the ones that are served (`content.json`), not fixtures: what has to hold is that the engine grades what the lessons
 * actually wrote, so every exercise has to accept its right answer and turn down each wrong answer the lesson planned, with that
 * answer's own «perché».
 */

interface Content {
  v: number
  percorsi: { tema: string; titolo: string; lezioni: Lesson[] }[]
}
interface Exercise {
  id: string
  tipo: string
  difficolta: number
  giusta?: number | string[]
  opzioni?: string[]
  testo?: string
  banca?: string[]
  elementi?: string[]
  righe?: string[]
  giuste?: number[]
  coppie?: { sinistra: string; destra: string }[]
  sbagliate: { risposta: unknown; perche: string }[]
}
interface Lesson {
  id: string
  numero: number
  titolo: string
  teoria: { id: string; testo: string }[]
  esercizi: Exercise[]
}
const content = JSON.parse(readFileSync(join(import.meta.dir, "content.json"), "utf8")) as Content
const lezioni: Lesson[] = content.percorsi.flatMap((percorso) => percorso.lezioni)
/** What the page lists: the lessons of the path it opens on. The others are one tab away. */
const primoPercorso = content.percorsi[0].lezioni
const esercizi: Exercise[] = lezioni.flatMap((lezione) => lezione.esercizi)

/** The answer the lesson says is right. */
function giusta(esercizio: Exercise): unknown {
  switch (esercizio.tipo) {
    case "ordina":
      return esercizio.elementi!.map((_, n) => n)
    case "trova-riga":
      return esercizio.giuste
    case "abbina":
      return Object.fromEntries(esercizio.coppie!.map((coppia) => [coppia.sinistra, coppia.destra]))
    default:
      return esercizio.giusta
  }
}

/** One wrong answer the lesson wrote down, in the shape its type is graded in. */
function sbagliata(esercizio: Exercise, risposta: unknown): unknown {
  switch (esercizio.tipo) {
    case "trova-riga":
      return [risposta as number]
    case "abbina": {
      const coppia = risposta as { sinistra: string; destra: string }
      return Object.fromEntries(
        esercizio.coppie!.map((voce) => [voce.sinistra, voce.sinistra === coppia.sinistra ? coppia.destra : voce.destra]),
      )
    }
    default:
      return risposta
  }
}

describe("the progress, from what came off the disk", () => {
  test("what nobody wrote yet", () => {
    expect(emptyProgress()).toEqual({ v: 1, xp: 0, giorni: [], esercizi: {} })
  })

  test("what is not a progress becomes the zero of each field, and the rest survives", () => {
    for (const rotta of [undefined, null, 3, "x", [], { v: 2 }]) expect(normalizeProgress(rotta)).toEqual(emptyProgress())
    const mezzo = normalizeProgress({
      v: 1,
      xp: 41.7,
      giorni: ["2026-10-06", "2026-10-06", "ieri", "2026-10-05"],
      esercizi: { "l01-e01": { viste: 3, giuste: 2, intervallo: 900, dovuta: "domani" }, rotto: "no" },
    })
    expect(mezzo.xp).toBe(41)
    // The same day twice is one day, and the days are read in order.
    expect(mezzo.giorni).toEqual(["2026-10-05", "2026-10-06"])
    expect(mezzo.esercizi["l01-e01"]).toEqual({ viste: 3, giuste: 2, intervallo: MAX_INTERVAL, dovuta: undefined })
    expect(mezzo.esercizi.rotto).toBeUndefined()
  })

  test("only a document that says which version it is is a progress to import", () => {
    expect(isProgress({ v: 1 })).toBe(true)
    for (const rotta of [undefined, null, "{}", [], { v: 2 }, { xp: 1 }]) expect(isProgress(rotta)).toBe(false)
  })

  test("every exercise has a unique progress key across all lessons and percorsi", () => {
    const keys = content.percorsi.flatMap((p) => p.lezioni.flatMap((l) => l.esercizi.map((e) => exerciseKey(l, e))))
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe("the streak, read from the days at every opening", () => {
  const giorni = (...iso: string[]) => iso

  test("days in a row count, and a day not done yet does not break yesterday's", () => {
    expect(streak(giorni("2026-10-06", "2026-10-05", "2026-10-04"), "2026-10-06").giorni).toBe(3)
    expect(streak(giorni("2026-10-05", "2026-10-04"), "2026-10-06").giorni).toBe(2)
    expect(streak(giorni(), "2026-10-06")).toEqual({ giorni: 0, congelati: 0 })
  })

  test("one day missing in the middle is the freeze of the week", () => {
    const sette = giorni(...Array.from({ length: 7 }, (_, n) => addDays("2026-10-06", -n)))
    // Nothing to spend yet: the seventh day breaks it.
    expect(streak(sette, "2026-10-06").giorni).toBe(7)
    const otto = [addDays("2026-10-06", -7), ...sette]
    expect(streak(otto, "2026-10-06")).toEqual({ giorni: 8, congelati: 0 })
  })

  test("two days in a row missing end the streak", () => {
    const giorni9 = Array.from({ length: 9 }, (_, n) => addDays("2026-10-06", -n))
    // 06 and 05 done, 04 and 03 missing, and the streak has one freeze to spend: it stops on the 03.
    const serie = streak([...giorni9.slice(0, 7), ...giorni9.slice(8)], "2026-10-06")
    expect(serie.giorni).toBe(8)
    expect(serie.congelati).toBe(0)
  })
})

describe("what an answer is worth", () => {
  test("XP by how hard the exercise is, and two for having read why it was wrong", () => {
    expect([1, 2, 3].map((difficolta) => xpFor(true, difficolta))).toEqual([10, 20, 30])
    expect([1, 3].map((difficolta) => xpFor(false, difficolta))).toEqual([2, 2])
  })

  test("a level every sixty, and never below the first", () => {
    expect([0, 59, 60, 61, 600].map(levelFor)).toEqual([1, 1, 2, 2, 11])
    expect(levelFor(-5)).toBe(1)
  })

  test("a right answer lets an exercise rest longer, and less so if it is hard", () => {
    expect(nextInterval(undefined, true, 1)).toBe(1)
    expect(nextInterval({ intervallo: 3 }, true, 1)).toBe(9)
    expect(nextInterval({ intervallo: 3 }, true, 2)).toBe(6)
    expect(nextInterval({ intervallo: 3 }, true, 3)).toBe(5)
    expect(nextInterval({ intervallo: 40 }, true, 1)).toBe(MAX_INTERVAL)
    // A wrong one comes back the next day, whatever it was doing.
    expect(nextInterval({ intervallo: 20 }, false, 1)).toBe(1)
  })

  test("an answer moves the progress without touching the one it came from", () => {
    const prima = normalizeProgress({ v: 1, xp: 10, giorni: ["2026-10-05"], esercizi: {} })
    const lezione = lezioni[0]
    const esercizio = esercizi[0]
    const dopo = recordAnswer(prima, lezione, esercizio, true, "2026-10-06")
    const chiave = exerciseKey(lezione, esercizio)
    expect(dopo.xp).toBe(10 + xpFor(true, esercizio.difficolta))
    expect(dopo.giorni).toEqual(["2026-10-05", "2026-10-06"])
    expect(dopo.esercizi[chiave]).toEqual({
      viste: 1,
      giuste: 1,
      intervallo: 1,
      dovuta: "2026-10-07",
    })
    expect(prima.esercizi).toEqual({})
    expect(prima.giorni).toEqual(["2026-10-05"])
    // The same day twice is still one day.
    expect(recordAnswer(dopo, lezione, esercizio, false, "2026-10-06").giorni).toEqual(["2026-10-05", "2026-10-06"])
  })

  test("the ripasso is the exercises whose day has come, and nothing that is not there", () => {
    const lezione = lezioni[0]
    const esercizio = esercizi[0]
    const progress = recordAnswer(emptyProgress(), lezione, esercizio, true, "2026-10-01")
    expect(dueReview(progress, lezioni, "2026-10-01")).toEqual([])
    expect(dueReview(progress, lezioni, "2026-10-02")).toEqual([{ lezione, esercizio }])
    expect(dueReview(progress, lezioni, "2026-11-01")).toEqual([{ lezione, esercizio }])
  })

  test("exercises with the same local id across different lessons do not collide in progress or ripasso", () => {
    const l1 = { id: "p1/01", esercizi: [{ id: "l01-e01", difficolta: 1 }] } as Lesson
    const l2 = { id: "p2/01", esercizi: [{ id: "l01-e01", difficolta: 1 }] } as Lesson
    const prog1 = recordAnswer(emptyProgress(), l1, l1.esercizi[0], true, "2026-10-01")
    expect(dueReview(prog1, [l1, l2], "2026-10-02")).toEqual([{ lezione: l1, esercizio: l1.esercizi[0] }])
    expect(prog1.esercizi[exerciseKey(l1, l1.esercizi[0])]).toBeDefined()
    expect(prog1.esercizi[exerciseKey(l2, l2.esercizi[0])]).toBeUndefined()
  })
})

describe("the correction, which is the whole of what an exercise does", () => {
  test("every exercise of the path accepts its right answer", () => {
    for (const esercizio of esercizi) expect([esercizio.id, checkAnswer(esercizio, giusta(esercizio))]).toEqual([esercizio.id, { ok: true }])
  })

  test("every wrong answer the lesson wrote down is turned down with its own «perché»", () => {
    let contati = 0
    for (const esercizio of esercizi) {
      for (const voce of esercizio.sbagliate) {
        const esito = checkAnswer(esercizio, sbagliata(esercizio, voce.risposta))
        expect([esercizio.id, voce.perche, esito.ok]).toEqual([esercizio.id, voce.perche, false])
        expect([esercizio.id, esito.perche]).toEqual([esercizio.id, voce.perche])
        contati += 1
      }
    }
    // Every exercise has at least two, and there is one of each type in this path.
    expect(contati).toBeGreaterThanOrEqual(esercizi.length * 2)
  })

  test("a wrong answer nobody planned still gets the explanation of the right one, and says so", () => {
    const scelta = esercizi.find((esercizio) => esercizio.tipo === "scelta")!
    const esito = checkAnswer(scelta, 99)
    expect(esito.ok).toBe(false)
    expect(esito.previsto).toBe(false)
    expect(esito.perche).toContain("non è fra quelle previste")
    // A partially done «completa», with a word nobody wrote in the bank.
    const completa = esercizi.find((esercizio) => esercizio.tipo === "completa")!
    expect(checkAnswer(completa, (completa.giusta as string[]).map(() => "parolainventata")).previsto).toBe(false)
    // And nothing at all is a right answer.
    expect(checkAnswer(completa, []).ok).toBe(false)
    expect(checkAnswer(scelta, undefined).ok).toBe(false)
  })

  test("a type it does not know is a wrong answer, not a crash", () => {
    expect(checkAnswer({ tipo: "futuro", sbagliate: [] }, 1).ok).toBe(false)
  })

  test("in «trova-riga» the answer is the set of lines, in any order", () => {
    const esercizio = esercizi.find((voce) => voce.tipo === "trova-riga" && voce.giuste!.length > 1)!
    const giuste = [...esercizio.giuste!].reverse()
    expect(checkAnswer(esercizio, giuste)).toEqual({ ok: true })
    // One right line is not enough when the lesson asks for two.
    const meta = checkAnswer(esercizio, [esercizio.giuste![0]])
    expect(meta.ok).toBe(false)
    expect(meta.perche).toBeTruthy()
  })
})

describe("the presentation is mixed from a seed, not from luck", () => {
  test("the same seed, the same order; another seed, another one", () => {
    const voci = ["a", "b", "c", "d", "e"]
    expect(shuffle(voci, 7)).toEqual(shuffle(voci, 7))
    expect(shuffle(voci, 7)).not.toEqual(voci)
    expect(shuffle(voci, 7)).not.toEqual(shuffle(voci, 8))
    // It is always the same list, not a shorter or a doubled one.
    expect([...shuffle(voci, 7)].sort()).toEqual([...voci].sort())
  })

  test("an exercise is mixed the same way however many times it is opened", () => {
    const lezione = lezioni[0]
    const primo = shuffle(lezione.esercizi, seedOf(lezione.id))
    expect(shuffle(lezione.esercizi, seedOf(lezione.id))).toEqual(primo)
    expect(shuffle(lezione.esercizi, seedOf(lezione.id) + 1)).not.toEqual(primo)
    // And the real ids give different orders, so the path is not a page that always looks the same.
    for (const percorso of content.percorsi) {
      expect(new Set(percorso.lezioni.map((voce) => shuffle(voce.esercizi, seedOf(voce.id))[0].id)).size).toBe(percorso.lezioni.length)
    }
  })
})

describe("a theory card is drawn as text, never as markup", () => {
  test("the marks of the theory become elements and the words stay words", () => {
    const fuori = rich(document, "Un **token** è un *pezzo* di `testo`.\n- uno\n- due")
    expect(fuori.querySelector("strong")?.textContent).toBe("token")
    expect(fuori.querySelector("em")?.textContent).toBe("pezzo")
    expect(fuori.querySelector("code")?.textContent).toBe("testo")
    expect(fuori.querySelectorAll("li")).toHaveLength(2)
    expect(fuori.textContent).toContain("Un token è un pezzo di testo.")
  })

  test("what a lesson writes is text, so an exercise cannot bring a tag with it", () => {
    const ostile = '<img src=x onerror="alert(1)"> **<b>x</b>**'
    const fuori = rich(document, ostile)
    expect(fuori.querySelector("img")).toBeNull()
    expect(fuori.querySelector("b")).toBeNull()
    expect(fuori.querySelector("strong")?.textContent).toBe("<b>x</b>")
  })
})

describe("the page and ADE, over one port", () => {
  const NONCE = "0123456789abcdef".repeat(3)

  function fakePage(hash: string) {
    document.body.innerHTML =
      '<main id="learn"><header><span id="summary"></span></header><div id="view"></div><p id="empty"></p></main>'
    const listeners = new Map<string, (event: unknown) => void>()
    const toParent: unknown[][] = []
    const parent = { postMessage: (...args: unknown[]) => void toParent.push(args) }
    const port = () => {
      const seen: unknown[] = []
      return { seen, postMessage: (message: unknown) => void seen.push(message), onmessage: undefined as unknown }
    }
    const win = {
      document,
      parent,
      location: { hash },
      fetch: async (path: string) => ({ ok: true, status: 200, json: async () => (path === "content.json" ? content : undefined) }),
      addEventListener: (type: string, fn: (event: unknown) => void) => void listeners.set(type, fn),
      removeEventListener: (type: string) => void listeners.delete(type),
    }
    const offer = (source: unknown, ports: unknown[], type = PORT_OFFER) =>
      listeners.get("message")?.({ source, data: { type, version: 1 }, ports })
    const press = (key: string, defaultPrevented = false, target?: unknown) =>
      listeners.get("keydown")?.({ key, defaultPrevented, target })
    return { win, parent, toParent, port, offer, press }
  }

  /** What the port answered ADE with, of one type. */
  const salvati = (via: { seen: unknown[] }) => via.seen.filter((messaggio) => (messaggio as { type: string }).type === "learn-save")

  /** Answers the exercise on screen with the first wrong answer its own lesson wrote down, and returns the type it was. */
  const rispondiMale = () => {
    const box = document.querySelector<HTMLElement>(".esercizio[data-esercizio]")!
    const voce = esercizi.find((esercizio) => esercizio.id === box.dataset.esercizio)!
    const prevista = voce.sbagliate[0].risposta
    const verifica = () => document.querySelector<HTMLButtonElement>('[data-slot="verifica"]')!.click()
    if (voce.tipo === "scelta") document.querySelector<HTMLButtonElement>(`[data-opzione="${prevista}"]`)!.click()
    else if (voce.tipo === "trova-riga") {
      document.querySelector<HTMLButtonElement>(`[data-riga="${prevista}"]`)!.click()
      verifica()
    } else if (voce.tipo === "completa") {
      const parole = prevista as string[]
      const campi = [...document.querySelectorAll<HTMLInputElement>(".frase input")]
      campi.forEach((campo, n) => (campo.value = parole[n] ?? ""))
      verifica()
    } else if (voce.tipo === "ordina") {
      // The first item one place down: never the order the lesson wrote, and never a coin toss.
      document.querySelector<HTMLButtonElement>('[data-scendi="0"]')!.click()
      verifica()
    } else {
      // No pairing at all is not the right one.
      verifica()
    }
    return voce.tipo
  }

  test("it says hello with the nonce, and only a nonce counts", () => {
    expect(readNonce(`#n=${NONCE}`)).toBe(NONCE)
    for (const hash of ["", "#n=abc", `#n=${NONCE}zz`, `#n=${NONCE.toUpperCase()}`]) expect([hash, readNonce(hash)]).toEqual([hash, undefined])
    const { win, toParent } = fakePage(`#n=${NONCE}`)
    void boot(win)
    expect(toParent).toEqual([[{ type: HELLO, nonce: NONCE }, "*"]])
  })

  test("`a=` picks where the page opens: the game or the paths, and anything else is the paths", async () => {
    for (const [hash, luogo] of [
      [`#n=${NONCE}&a=gioco`, "gioco"],
      [`#n=${NONCE}&a=percorsi`, "percorsi"],
      [`#n=${NONCE}&a=altro`, "percorsi"],
      [`#n=${NONCE}&a=GIOCO`, "percorsi"],
      [`#n=${NONCE}&a=`, "percorsi"],
      [`#n=${NONCE}`, "percorsi"],
      [`#a=gioco&n=${NONCE}`, "gioco"],
    ] as const) {
      expect([hash, readPlace(hash)]).toEqual([hash, luogo])
      const { win } = fakePage(hash)
      const stato = await boot(win)
      expect([hash, stato?.luogo]).toEqual([hash, luogo])
    }
  })

  test("Esc asks ADE to close the layer over the port, only once the port is there, and not when something else took the key", async () => {
    const { win, parent, port, offer, press } = fakePage(`#n=${NONCE}`)
    await boot(win)
    // No port yet: nobody to ask, nothing thrown.
    press("Escape")
    const via = port()
    offer(parent, [via])
    expect(via.seen).toEqual([{ type: "ready" }])
    press("a")
    press("Enter")
    press("Escape", true)
    expect(via.seen).toEqual([{ type: "ready" }])
    press("Escape")
    expect(via.seen).toEqual([{ type: "ready" }, { type: "close" }])
  })

  test("Esc in a field with something typed in it does not close the layer, and in an empty one it does", async () => {
    const { win, parent, port, offer, press } = fakePage(`#n=${NONCE}`)
    await boot(win)
    const via = port()
    offer(parent, [via])
    press("Escape", false, { tagName: "INPUT", value: "meta' di una rispos" })
    press("Escape", false, { tagName: "TEXTAREA", value: "x" })
    expect(via.seen).toEqual([{ type: "ready" }])
    press("Escape", false, { tagName: "INPUT", value: "" })
    press("Escape", false, { tagName: "BUTTON", value: "" })
    expect(via.seen).toEqual([{ type: "ready" }, { type: "close" }, { type: "close" }])
  })

  test("without the nonce it says nothing, and no port offered to it is taken", async () => {
    const { win, parent, toParent, port, offer } = fakePage("")
    expect(await boot(win)).toBeUndefined()
    expect(toParent).toEqual([])
    expect(document.getElementById("empty")?.textContent).toBe("Questa pagina va aperta da ADE.")
    const stranger = port()
    offer(parent, [stranger])
    expect(stranger.onmessage).toBeUndefined()
  })

  test("the port is taken from its parent only, once, and answered with `ready`", async () => {
    const { win, parent, port, offer } = fakePage(`#n=${NONCE}`)
    await boot(win)
    const stranger = port()
    offer({ name: "another window" }, [stranger])
    expect(stranger.onmessage).toBeUndefined()
    offer(parent, [], PORT_OFFER)
    const taken = port()
    offer(parent, [taken])
    expect(taken.seen).toEqual([{ type: "ready" }])
    const secondo = port()
    offer(parent, [secondo])
    expect(secondo.onmessage).toBeUndefined()
  })

  test("the progress comes from ADE, and only `progress` is believed", async () => {
    const { win, parent, port, offer } = fakePage(`#n=${NONCE}`)
    await boot(win)
    const via = port()
    offer(parent, [via])
    const lista = document.querySelectorAll(".lesson")
    expect(lista).toHaveLength(primoPercorso.length)
    expect(lista[0]?.querySelector(".testo span")?.textContent).toBe(primoPercorso[0].titolo)
    const invia = (data: unknown) => (via.onmessage as (event: unknown) => void)({ data })
    invia({ type: "progress", progress: { v: 1, xp: 90, giorni: ["2026-10-06"], esercizi: {} } })
    expect(document.getElementById("summary")?.textContent).toContain("90 XP")
    expect(document.getElementById("summary")?.textContent).toContain("livello 2")
    // Anything else on the port is ignored, with a line in the console, and changes nothing.
    const avvisi = mock((...args: unknown[]) => void args)
    const prima = console.warn
    console.warn = avvisi
    try {
      for (const data of [{ type: "shutdown" }, null, "ciao", 7]) invia(data)
    } finally {
      console.warn = prima
    }
    expect(document.getElementById("summary")?.textContent).toContain("90 XP")
    expect(avvisi).toHaveBeenCalled()
    // A progress that is not one becomes the empty one, not a crash.
    invia({ type: "progress", progress: "non è un progresso" })
    expect(document.getElementById("summary")?.textContent).toStartWith("0 XP")
  })

  test("every exercise, answered wrong, saves the progress and says why", async () => {
    const { win, parent, port, offer } = fakePage(`#n=${NONCE}`)
    await boot(win)
    const via = port()
    offer(parent, [via])
    // The first lesson: its theory, then all of its exercises.
    document.querySelector<HTMLButtonElement>(".lesson")!.click()
    const teoria = primoPercorso[0].teoria.length
    for (let i = 0; i < teoria; i += 1) document.querySelector<HTMLButtonElement>(".azioni button.principale")!.click()
    const visti = new Set<string>()
    for (let n = 0; n < primoPercorso[0].esercizi.length + 1; n += 1) {
      const box = document.querySelector<HTMLElement>(".esercizio[data-esercizio]")
      if (!box) break
      visti.add(box.dataset.esercizio!)
      rispondiMale()
      expect([box.dataset.esercizio, document.querySelector(".verdetto")?.getAttribute("data-esito")]).toEqual([
        box.dataset.esercizio,
        "sbagliata",
      ])
      // The «perché» is the lesson's own words, not a shrug.
      expect(document.querySelector(".verdetto")?.textContent?.length).toBeGreaterThan(20)
      expect(salvati(via)).toHaveLength(n + 1)
      document.querySelector<HTMLButtonElement>('[data-slot="prossima"]')!.click()
    }
    expect(visti.size).toBe(primoPercorso[0].esercizi.length)
    const salvato = salvati(via).at(-1) as { progress: { v: number; xp: number; giorni: string[]; esercizi: Record<string, unknown> } }
    expect(salvato.progress.v).toBe(1)
    // A wrong answer is worth something too: two XP for having read why.
    expect(salvato.progress.xp).toBe(primoPercorso[0].esercizi.length * 2)
    expect(salvato.progress.giorni).toHaveLength(1)
    expect(Object.keys(salvato.progress.esercizi)).toEqual([...visti].map((id) => `${primoPercorso[0].id}#${id}`))
    // The end of the lesson, and back to the list.
    expect(document.querySelector(".esercizio h2")?.textContent).toBe(`Fine di ${primoPercorso[0].titolo}`)
    expect(document.querySelector(".cifre")?.textContent).toContain("11")
    document.querySelector<HTMLButtonElement>('[data-slot="torna"]')!.click()
    expect(document.querySelectorAll(".lesson")).toHaveLength(primoPercorso.length)
  })

  test("the end of a ripasso is titled as a ripasso, not after the lesson of its first exercise", async () => {
    const { win, parent, port, offer } = fakePage(`#n=${NONCE}`)
    await boot(win)
    const via = port()
    offer(parent, [via])
    const esercizio = lezioni[0].esercizi[0]
    const invia = (data: unknown) => (via.onmessage as (event: unknown) => void)({ data })
    invia({
      type: "progress",
      progress: {
        v: 1,
        xp: 4,
        giorni: ["2026-01-01"],
        esercizi: { [`${lezioni[0].id}#${esercizio.id}`]: { viste: 1, giuste: 1, intervallo: 1, dovuta: "2026-01-02" } },
      },
    })
    const ripasso = [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.startsWith("Ripasso"))
    expect(ripasso).toBeDefined()
    ripasso!.click()
    rispondiMale()
    document.querySelector<HTMLButtonElement>('[data-slot="prossima"]')!.click()
    expect(document.querySelector(".esercizio h2")?.textContent).toBe("Fine del ripasso")
    expect(document.querySelector(".cifre")?.textContent).toContain("in questo ripasso")
  })
})

describe("the page is served, not built", () => {
  const page = readFileSync(join(import.meta.dir, "page", "index.html"), "utf8")
  const engine = readFileSync(join(import.meta.dir, "page", "learn.js"), "utf8")

  test("no HTML is ever built from a lesson, and there is nothing inline", () => {
    for (const where of [engine]) {
      for (const vietato of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval("]) {
        expect([vietato, where.includes(vietato)]).toEqual([vietato, false])
      }
    }
    expect(page.includes("<style")).toBe(false)
    expect(page.includes(" onclick=")).toBe(false)
    // The CSP has no `unsafe-inline` for styles, so a `style` attribute set from the page would be refused: the page styles with classes.
    expect(/["'`]style["'`]\s*:|style:\s*["'`]|setAttribute\(\s*["']style["']/.test(engine)).toBe(false)
    for (const script of page.split("<script").slice(1)) expect(script.split(">")[0]).toContain("src=")
    // The page asks for files of its own (the lessons and the game's levels): no network, and nothing of ADE's.
    for (const richiamo of engine.matchAll(/(?:fetch|src|href)\(?\s*["'`]([^"'`]+)/g)) {
      expect(["content.json", "gioco.json", "learn.js", "learn.css"]).toContain(richiamo[1])
    }
  })
})