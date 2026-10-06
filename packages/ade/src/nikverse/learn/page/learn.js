/*
 * «Impara»: the lesson engine and its page, in plain JavaScript with no build, served by the `nikverse` scheme under `/learn/`.
 *
 * It runs in a frame of its own, so it is not ADE's origin and it has no line to ADE except one MessageChannel port. ADE hands it over
 * once, and only after the page has sent back, in a `hello`, the nonce ADE put in its address: a page that is not this one has not got
 * it. What ADE sends is the learner's progress; what the page sends back is `ready` and, each time an exercise is answered, the progress
 * to write. Nothing else is believed: a message that is not on the list is a `console.warn` and nothing else.
 *
 * The engine is the set of pure functions below — grading, XP, the streak, the spaced repetition — and `learn.test.ts` runs them
 * without a page, the way `world.test.ts` does for the world. What is left is the drawing, which is plain DOM: a lesson, an objective,
 * a wrong answer is text, and no text is ever parsed as markup (`rich`, below, only splits text and re-inserts it as text).
 *
 * Nothing here asks a model. A wrong answer is graded against what the lesson wrote down, and shown with the «perché» that was written
 * next to it when the lesson was reviewed.
 */

/** ADE hands the port over in a message with this type, and nothing else on `window` is believed. */
export const PORT_OFFER = "nikverse:port"

/** The page says this to its parent, with the nonce ADE put in its address: the proof it is this page. */
export const HELLO = "nikverse:hello"

/** The nonce in the address fragment (`#n=…`), or nothing. */
export function readNonce(hash) {
  const value = new URLSearchParams(String(hash).replace(/^#/, "")).get("n")
  return value && /^[0-9a-f]{32,}$/.test(value) ? value : undefined
}

const PROGRESS_VERSION = 1
/** The most an exercise can come back for the same right answer: past this, it rests. */
export const MAX_INTERVAL = 30

// ---------------------------------------------------------------- the progress

/**
 * @typedef {{ viste: number, giuste: number, intervallo: number, dovuta?: string }} ExerciseRecord
 * @typedef {{ v: number, xp: number, giorni: string[], esercizi: Record<string, ExerciseRecord> }} Progress
 */

/** What a learner who has not opened a single lesson has.
 *
 * @returns {Progress}
 */
export function emptyProgress() {
  return { v: PROGRESS_VERSION, xp: 0, giorni: [], esercizi: {} }
}

const isIso = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
const intero = (value) => (Number.isInteger(value) && value >= 0 ? value : 0)

/**
 * Reads what came from disk (or from an exported file) into a progress to work with: anything that is not there becomes the zero it
 * should be. A field that is wrong is not a reason to throw the rest away, because losing a month of lessons over one odd value is
 * worse than the odd value; what it is not is a licence to run on a value of the wrong shape.
 *
 * @returns {Progress}
 */
export function normalizeProgress(raw) {
  const progress = emptyProgress()
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return progress
  const body = raw
  progress.xp = Number.isFinite(body.xp) ? Math.max(0, Math.floor(body.xp)) : 0
  if (Array.isArray(body.giorni)) {
    // Deduped and in order: the same day twice must not make a streak longer than the calendar.
    progress.giorni = [...new Set(body.giorni.filter(isIso))].sort()
  }
  for (const [id, record] of Object.entries(body.esercizi ?? {})) {
    if (!record || typeof record !== "object" || Array.isArray(record)) continue
    progress.esercizi[id] = {
      viste: intero(record.viste),
      giuste: intero(record.giuste),
      intervallo: Math.min(MAX_INTERVAL, intero(record.intervallo)),
      dovuta: isIso(record.dovuta) ? record.dovuta : undefined,
      ...(intero(record.stelle) > 0 ? { stelle: Math.min(3, intero(record.stelle)) } : {}),
      ...(intero(record.punti) > 0 ? { punti: intero(record.punti) } : {}),
    }
  }
  return progress
}

/** Whether a document is a progress to import: the version, or nothing. */
export function isProgress(raw) {
  return Boolean(raw && typeof raw === "object" && !Array.isArray(raw) && raw.v === PROGRESS_VERSION)
}

// ---------------------------------------------------------------- days

/** A day as `YYYY-MM-DD`, worked in UTC so the machine's timezone cannot move a calendar day. */
export function isoDay(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())).toISOString().slice(0, 10)
}

/** `giorni` days after `day`, as `YYYY-MM-DD`. */
export function addDays(day, giorni) {
  const date = new Date(`${day}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + giorni)
  return date.toISOString().slice(0, 10)
}

/**
 * The streak of days, with one freeze for every week of it.
 *
 * A day the learner did something lengthens the streak; a day missing from the middle costs one of the freezes the streak has earned,
 * one for each seven days. Two days in a row missing end it. Nothing runs while the panel is closed: the streak is read from the days
 * that are in the progress, at every opening.
 */
export function streak(giorni, oggi) {
  const days = new Set(giorni)
  // A day not done yet does not break a streak that is still alive from yesterday; it only says it is not today yet.
  let cursor = days.has(oggi) ? oggi : addDays(oggi, -1)
  let count = 0
  let spese = 0
  while (count < 5000) {
    if (days.has(cursor)) count += 1
    else if (Math.floor(count / 7) - spese <= 0) break
    else spese += 1
    cursor = addDays(cursor, -1)
  }
  return { giorni: count, congelati: Math.max(0, Math.floor(count / 7) - spese) }
}

// ---------------------------------------------------------------- XP

/** What an answer is worth: a right one by how hard the exercise is, a wrong one for having read why. */
export function xpFor(ok, difficolta) {
  return ok ? 10 * Math.max(1, Number(difficolta) || 1) : 2
}

/** The level a total of XP is: one every 60, so the first levels come fast and then it is work. */
export function levelFor(xp) {
  return Math.floor(Math.max(0, xp) / 60) + 1
}

/** How long until an exercise comes back, in days. A right answer lets it rest longer, less so if the exercise is hard. */
export function nextInterval(record, ok, difficolta) {
  if (!ok) return 1
  const crescita = Number(difficolta) >= 3 ? 1.5 : Number(difficolta) === 2 ? 2 : 3
  const precedente = record?.intervallo ?? 0
  if (precedente <= 0) return 1
  return Math.min(MAX_INTERVAL, Math.round(precedente * crescita))
}

/** The key under which an exercise is kept in the progress: the lesson's id and the exercise's, so paths never collide. */
export function exerciseKey(lezione, esercizio) {
  const lezioneId = typeof lezione === "string" ? lezione : lezione?.id ?? ""
  return `${lezioneId}#${esercizio.id}`
}

/**
 * The progress after one answer: the XP, the day, and how far the exercise now rests.
 *
 * A new object, never the same one changed: the page keeps the previous progress to save, and a save that cannot fail halfway has to
 * start from the value as it was before.
 *
 * @returns {Progress}
 */
export function recordAnswer(progress, lezione, esercizio, ok, oggi) {
  let l = lezione
  let e = esercizio
  let o = ok
  let d = oggi
  if (typeof o === "string" || (o === undefined && typeof e === "boolean")) {
    d = o
    o = e
    e = l
    l = e._lezione ?? e.lezione ?? ""
  }
  const key = exerciseKey(l, e)
  const prima = progress.esercizi[key] ?? { viste: 0, giuste: 0, intervallo: 0 }
  const intervallo = nextInterval(prima, o, e.difficolta)
  return {
    v: PROGRESS_VERSION,
    xp: progress.xp + xpFor(o, e.difficolta),
    giorni: progress.giorni.includes(d) ? progress.giorni : [...progress.giorni, d].sort(),
    esercizi: {
      ...progress.esercizi,
      [key]: {
        viste: prima.viste + 1,
        giuste: prima.giuste + (o ? 1 : 0),
        intervallo,
        dovuta: addDays(d, intervallo),
      },
    },
  }
}

/** The exercises whose turn has come: the ripasso, read when the panel opens and not kept alive by a timer. */
export function dueReview(progress, lezioni, oggi) {
  const scaduti = []
  for (const lezione of lezioni) {
    for (const esercizio of lezione.esercizi) {
      const record = progress.esercizi[exerciseKey(lezione, esercizio)]
      if (record?.dovuta && record.dovuta <= oggi) scaduti.push({ lezione, esercizio })
    }
  }
  return scaduti
}

// ---------------------------------------------------------------- grading

const sameList = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i])
const sameSet = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && [...a].sort().join() === [...b].sort().join()
const identity = (n) => Array.from({ length: n }, (_, i) => i)

/** The «perché» the lesson wrote for exactly this wrong answer, when it wrote one. */
function whyOf(sbagliate, risposta) {
  return sbagliate.find((sbagliata) => sameList(sbagliata.risposta, risposta))?.perche
}

const FUORI = "Questa risposta non è fra quelle previste dalla lezione: sotto c'è la spiegazione di quella giusta."

/**
 * Grades one answer, from what the lesson wrote down, with no model and no timer.
 *
 * A wrong answer is told why it is wrong: a lesson has a «perché» for every wrong answer it expects, and the one the learner gave is
 * looked up there. A wrong answer nobody expected (a word typed into «completa», a pairing that was never written) is still told what
 * the right one is, and says that its own is not one of the planned ones.
 *
 * @returns {{ ok: boolean, perche?: string, previsto?: boolean }}
 */
export function checkAnswer(esercizio, risposta) {
  const fuori = { ok: false, perche: FUORI, previsto: false }
  const sbagliata = (perche) => ({ ok: false, perche, previsto: true })
  switch (esercizio.tipo) {
    case "scelta": {
      if (risposta === esercizio.giusta) return { ok: true }
      // `scelta` counts its wrong answers by index, not in a list.
      const perche = esercizio.sbagliate.find((voce) => voce.risposta === risposta)?.perche
      return perche ? sbagliata(perche) : fuori
    }
    case "completa":
      if (sameList(risposta, esercizio.giusta)) return { ok: true }
      return whyOf(esercizio.sbagliate, risposta) ? sbagliata(whyOf(esercizio.sbagliate, risposta)) : fuori
    case "ordina": {
      if (sameList(risposta, identity(esercizio.elementi.length))) return { ok: true }
      return whyOf(esercizio.sbagliate, risposta) ? sbagliata(whyOf(esercizio.sbagliate, risposta)) : fuori
    }
    case "trova-riga": {
      if (sameSet(risposta, esercizio.giuste)) return { ok: true }
      // The first line that was picked and is not right is the one the learner has to be told about.
      const voce = esercizio.sbagliate.find((s) => !esercizio.giuste.includes(s.risposta) && risposta.includes(s.risposta))
      return voce ? sbagliata(voce.perche) : fuori
    }
    case "abbina": {
      const giusta = Object.fromEntries(esercizio.coppie.map((coppia) => [coppia.sinistra, coppia.destra]))
      const stesse = (a) =>
        Boolean(a) && typeof a === "object" && Object.keys(a).length === Object.keys(giusta).length && Object.keys(giusta).every((sinistra) => a[sinistra] === giusta[sinistra])
      if (stesse(risposta)) return { ok: true }
      const voce = esercizio.sbagliate.find((s) => risposta?.[s.risposta.sinistra] === s.risposta.destra)
      return voce ? sbagliata(voce.perche) : fuori
    }
    default:
      return fuori
  }
}

// ---------------------------------------------------------------- presentation

/** A seed out of a text, so an exercise is always mixed the same way (`shuffle`). */
export function seedOf(text) {
  let hash = 2166136261
  for (let i = 0; i < String(text).length; i += 1) {
    hash ^= String(text).charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

/**
 * The same list, mixed, from a seed.
 *
 * `Math.random` would make every test of the engine a test of luck, and would bring an exercise back in a different order every time
 * it is opened. Mixing on a seed keeps both out, and the attempt number is mixed in with it so a retry is not the same page.
 */
export function shuffle(list, seed) {
  const out = [...list]
  let stato = (Number(seed) || 1) >>> 0
  for (let i = out.length - 1; i > 0; i -= 1) {
    stato = (Math.imul(stato, 1664525) + 1013904223) >>> 0
    const j = stato % (i + 1)
    const tenuto = out[i]
    out[i] = out[j]
    out[j] = tenuto
  }
  return out
}

/** The marks the theory is written with: bold, italic and inline code. Nothing else is a mark in a lesson. */
const MARKS = /\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`/g

/** One node, filled with text: the marks become elements, and the words between them stay text. */
function arricchito(doc, nodo, testo) {
  let fine = 0
  for (const match of testo.matchAll(MARKS)) {
    const [intero, grassetto, corsivo, codice] = match
    if (match.index > fine) nodo.append(doc.createTextNode(testo.slice(fine, match.index)))
    const dentro = grassetto ?? corsivo ?? codice
    const segno = doc.createElement(grassetto ? "strong" : corsivo ? "em" : "code")
    segno.textContent = dentro
    nodo.append(segno)
    fine = match.index + intero.length
  }
  if (fine < testo.length) nodo.append(doc.createTextNode(testo.slice(fine)))
  return nodo
}

/**
 * Reduced Markdown as DOM, without ever parsing text as markup: the three marks of `MARKS`, and lines that begin with a dash or a
 * number, which become list items.
 */
export function rich(doc, testo) {
  const fuori = doc.createElement("div")
  let lista
  for (const linea of String(testo).split("\n")) {
    const voce = /^\s*(?:[-*]|\d+[.)])\s+(.*)$/.exec(linea)
    if (!voce) {
      lista = undefined
      if (linea.trim()) fuori.append(arricchito(doc, doc.createElement("p"), linea.trim()))
      continue
    }
    const tag = /^\s*\d/.test(linea) ? "ol" : "ul"
    if (lista?.tagName.toLowerCase() !== tag) {
      lista = doc.createElement(tag)
      fuori.append(lista)
    }
    lista.append(arricchito(doc, doc.createElement("li"), voce[1]))
  }
  return fuori
}

// ---------------------------------------------------------------- the game «Trova l'iniezione»

export const CATALOGO_GIOCO = {
  it: {
    trovaIniezione: "Trova l'iniezione",
    sottotitolo: "Un agente legge un documento per fare un compito: trova le righe che gli danno ordini estranei.",
    nessunaIniezione: "Nessuna iniezione",
    verifica: "Verifica segnalazioni",
    partitaInCorso: "Partita in corso",
    tempoScaduto: "Tempo scaduto!",
    secondi: "s",
    compito: "Compito dell'agente",
    documento: "Documento",
    difficolta: "Difficoltà",
    punteggio: "Punteggio",
    iniezioniTrovate: "Iniezioni trovate",
    iniezioniPerse: "Iniezioni non viste",
    falseSegnalazioni: "Segnalazioni errate",
    bonusTempo: "Bonus tempo",
    totaleXP: "Totale XP",
    spiegazione: "Spiegazione",
    riprova: "Riprova livello",
    tornaLivelli: "Torna ai livelli",
    prossimoLivello: "Livello successivo",
    tutteTrovate: "Tre stelle! Tutte trovate senza errori.",
    tutteConErrori: "Due stelle! Tutte trovate con alcune segnalazioni errate.",
    parziali: "Una stella! Iniezione individuata.",
    nessunaStella: "Nessuna stella. Riprova!",
    pulitoCorretto: "Tre stelle! Documento correttamente riconosciuto come pulito.",
    pulitoErrato: "Il documento era pulito: nessuna riga andava segnalata.",
  },
  en: {
    trovaIniezione: "Find the injection",
    sottotitolo: "An agent is reading a document: spot the lines giving unauthorized orders.",
    nessunaIniezione: "No injection",
    verifica: "Check reports",
    partitaInCorso: "Game in progress",
    tempoScaduto: "Time's up!",
    secondi: "s",
    compito: "Agent task",
    documento: "Document",
    difficolta: "Difficulty",
    punteggio: "Score",
    iniezioniTrovate: "Injections found",
    iniezioniPerse: "Missed injections",
    falseSegnalazioni: "False alarms",
    bonusTempo: "Time bonus",
    totaleXP: "Total XP",
    spiegazione: "Explanation",
    riprova: "Retry level",
    tornaLivelli: "Back to levels",
    prossimoLivello: "Next level",
    tutteTrovate: "Three stars! All found with zero mistakes.",
    tutteConErrori: "Two stars! All found with some false alarms.",
    parziali: "One star! Injection spotted.",
    nessunaStella: "No stars. Retry!",
    pulitoCorretto: "Three stars! Document correctly recognized as clean.",
    pulitoErrato: "The document was clean: no lines should have been reported.",
  },
}

export function t(chiave, lingua = "it") {
  const lang = lingua === "en" ? "en" : "it"
  return CATALOGO_GIOCO[lang]?.[chiave] ?? CATALOGO_GIOCO.it[chiave] ?? chiave
}

/**
 * Grades a player's answer on an injection game level deterministically.
 *
 * Scoring rules:
 * - +100 for each injection found
 * - -50 for each innocent line reported (decoys or normal lines)
 * - Time bonus for remaining time when successful
 * - 3 stars if all injections found (or clean level correctly identified) and 0 false reports
 * - 2 stars if all injections found but has false reports
 * - 1 star if some injections found
 * - 0 stars if none
 */
export function valutaLivello(livello, righeScelte, tempoRimanente = 0) {
  const scelte = new Set(Array.isArray(righeScelte) ? righeScelte : [])
  const iniezioni = []
  const esche = []
  const normali = []

  livello.righe.forEach((riga, idx) => {
    if (riga.tipo === "iniezione") iniezioni.push(idx)
    else if (riga.tipo === "esca") esche.push(idx)
    else normali.push(idx)
  })

  const isPulito = iniezioni.length === 0

  if (isPulito) {
    if (scelte.size === 0) {
      const tempoBonus = Math.max(0, Math.floor(tempoRimanente * 2))
      return {
        successo: true,
        isPulito: true,
        trovate: [],
        perse: [],
        falsePositive: [],
        escheSegnalate: [],
        puntiIniezioni: 100,
        penalita: 0,
        tempoBonus,
        punteggio: 100 + tempoBonus,
        stelle: 3,
      }
    } else {
      const falsePositive = [...scelte]
      const penalita = falsePositive.length * 50
      return {
        successo: false,
        isPulito: true,
        trovate: [],
        perse: [],
        falsePositive,
        escheSegnalate: falsePositive.filter((idx) => esche.includes(idx)),
        puntiIniezioni: 0,
        penalita,
        tempoBonus: 0,
        punteggio: 0,
        stelle: 0,
      }
    }
  }

  const trovate = iniezioni.filter((idx) => scelte.has(idx))
  const perse = iniezioni.filter((idx) => !scelte.has(idx))
  const falsePositive = [...scelte].filter((idx) => !iniezioni.includes(idx))
  const escheSegnalate = falsePositive.filter((idx) => esche.includes(idx))

  const tutteTrovate = trovate.length === iniezioni.length
  const puntiIniezioni = trovate.length * 100
  const penalita = falsePositive.length * 50
  const tempoBonus = tutteTrovate ? Math.max(0, Math.floor(tempoRimanente * 2)) : 0
  const punteggio = Math.max(0, puntiIniezioni - penalita + tempoBonus)

  let stelle = 0
  if (tutteTrovate && falsePositive.length === 0) stelle = 3
  else if (tutteTrovate && falsePositive.length > 0) stelle = 2
  else if (trovate.length > 0) stelle = 1

  return {
    successo: tutteTrovate,
    isPulito: false,
    trovate,
    perse,
    falsePositive,
    escheSegnalate,
    puntiIniezioni,
    penalita,
    tempoBonus,
    punteggio,
    stelle,
  }
}

/**
 * Countdown timer for an active game match. Only runs during play, never at rest.
 */
export class GiocoTimer {
  constructor(secondiIniziali, onTick, onScaduto) {
    this.secondi = Math.max(0, Number(secondiIniziali) || 0)
    this.onTick = onTick
    this.onScaduto = onScaduto
    this.timerId = null
    this.attivo = false
  }

  avvia() {
    if (this.attivo) return
    this.attivo = true
    this.timerId = setInterval(() => {
      this.secondi -= 1
      if (this.onTick) this.onTick(this.secondi)
      if (this.secondi <= 0) {
        this.ferma()
        if (this.onScaduto) this.onScaduto()
      }
    }, 1000)
  }

  ferma() {
    if (this.timerId !== null) {
      clearInterval(this.timerId)
      this.timerId = null
    }
    this.attivo = false
  }
}

// ---------------------------------------------------------------- the page

const el = (doc, tag, props = {}, ...children) => {
  const nodo = doc.createElement(tag)
  for (const [nome, valore] of Object.entries(props)) {
    if (nome === "text") nodo.textContent = valore
    else if (valore !== undefined && valore !== false) nodo.setAttribute(nome, valore === true ? "" : valore)
  }
  for (const figlio of children) if (figlio) nodo.append(figlio)
  return nodo
}

const azione = (doc, testo, onClick, props = {}, ...figli) => {
  const nodo = el(doc, "button", { type: "button", ...props, text: testo }, ...figli)
  nodo.addEventListener("click", onClick)
  return nodo
}

/** Today in the machine's own calendar: the streak is about the learner's days, not about UTC. */
function todayOf(win) {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`
}

/**
 * Starts the page: it says who it is to ADE, waits for the port, and everything drawn comes from the lesson or from the progress.
 *
 * Started only when the address carries ADE's nonce: a page opened on its own has nobody to answer to, so it shows nothing and says
 * nothing.
 */
export async function boot(win) {
  const doc = win.document
  const view = doc.getElementById("view")
  const summary = doc.getElementById("summary")
  const empty = doc.getElementById("empty")
  const nonce = readNonce(win.location?.hash ?? "")
  if (!view || !summary || !empty) return undefined
  if (!nonce) {
    empty.textContent = "Questa pagina va aperta da ADE."
    return undefined
  }

  const stato = {
    contenuti: undefined,
    gioco: undefined,
    modalita: "lezioni",
    progress: emptyProgress(),
    percorso: 0,
    lezione: 0,
    livelloCorrente: undefined,
    righeScelte: new Set(),
    secondiRimanenti: 0,
    timer: undefined,
    esitoGioco: undefined,
    fase: "lista",
    /** The exercises being asked now: a lesson's, or the ones the ripasso is due. */
    esercizi: [],
    indice: 0,
    tentativo: 0,
    risposta: undefined,
    esito: undefined,
    xp: 0,
    giuste: 0,
    sbagliate: 0,
    /** The exercises in hand are the ripasso's, from several lessons, and not one lesson's. */
    ripasso: false,
  }
  let port

  const salvataggio = () => {
    try {
      port?.postMessage({ type: "learn-save", progress: stato.progress })
    } catch (errore) {
      console.warn(`[impara] non riesco a salvare: ${String(errore?.message ?? errore)}`)
    }
  }

  /** The header line, from the progress, recomputed at every drawing: nothing here is on a timer. */
  const riquadro = () => {
    const serie = streak(stato.progress.giorni, todayOf(win))
    summary.textContent = `${stato.progress.xp} XP · livello ${levelFor(stato.progress.xp)} · serie di ${serie.giorni} ${serie.giorni === 1 ? "giorno" : "giorni"}`
  }

  const tutteLeLezioni = () => stato.contenuti?.percorsi?.flatMap((p) => p.lezioni) ?? []
  const lezioniDi = () => stato.contenuti?.percorsi[stato.percorso]?.lezioni ?? []

  const comincia = (esercizi, lezione) => {
    stato.esercizi = esercizi
    if (lezione !== undefined) stato.lezione = lezione
    stato.indice = 0
    stato.tentativo = 0
    stato.fase = esercizi.length ? "esercizio" : "fine"
    stato.risposta = undefined
    stato.esito = undefined
    stato.xp = 0
    stato.giuste = 0
    stato.sbagliate = 0
    stato.ripasso = false
  }

  const giocoLista = () => {
    const figli = []
    const selettore = el(doc, "div", { class: "percorsi", role: "tablist", "aria-label": "Modalità e percorsi" })
    stato.contenuti?.percorsi?.forEach((p, idx) => {
      selettore.append(
        azione(
          doc,
          p.titolo,
          () => {
            stato.modalita = "lezioni"
            stato.percorso = idx
            stato.fase = "lista"
            stato.timer?.ferma()
            disegna()
          },
          {
            role: "tab",
            "aria-selected": "false",
          },
        ),
      )
    })
    selettore.append(
      azione(
        doc,
        t("trovaIniezione"),
        () => {
          stato.modalita = "gioco"
          stato.fase = "gioco-lista"
          disegna()
        },
        {
          role: "tab",
          "aria-selected": "true",
          "data-attivo": "1",
          "data-slot": "tab-gioco",
        },
      ),
    )
    figli.push(selettore)
    figli.push(el(doc, "h2", { text: t("trovaIniezione") }))
    figli.push(el(doc, "p", { class: "origine", text: t("sottotitolo") }))

    const livelli = stato.gioco?.livelli ?? []
    livelli.forEach((livello) => {
      const rec = stato.progress.esercizi[`gioco#${livello.id}`]
      const stelleNum = rec?.stelle ?? 0
      const stelleStr = stelleNum > 0 ? "★".repeat(stelleNum) + "☆".repeat(3 - stelleNum) : "☆☆☆"
      figli.push(
        azione(
          doc,
          "",
          () => {
            giocoComincia(livello)
          },
          {
            class: "livello",
            "data-livello": String(livello.livello),
            "data-fatto": stelleNum === 3 ? "1" : undefined,
          },
          el(doc, "span", { class: "n", text: String(livello.livello), "aria-hidden": "true" }),
          el(
            doc,
            "span",
            { class: "testo" },
            el(doc, "span", { text: `${livello.etichetta} — ${livello.compito}` }),
            el(doc, "small", {
              text: `${livello.tappa} · ${livello.secondi}s · ${livello.righe.length} righe · Difficoltà ${livello.difficolta}/5`,
            }),
          ),
          el(doc, "span", { class: "stelle", text: stelleStr, "aria-label": `${stelleNum} ${t("stelle")}` }),
        ),
      )
    })
    view.replaceChildren(...figli)
    riquadro()
  }

  const giocoComincia = (livello) => {
    stato.livelloCorrente = livello
    stato.fase = "gioco-partita"
    stato.righeScelte = new Set()
    stato.secondiRimanenti = livello.secondi
    stato.esitoGioco = undefined
    stato.timer?.ferma()
    stato.timer = new GiocoTimer(
      livello.secondi,
      (sec) => {
        stato.secondiRimanenti = sec
        const pill = view.querySelector("[data-slot='timer']")
        if (pill) {
          pill.textContent = `⏱ ${sec}s`
          if (sec <= 10) pill.setAttribute("data-urgenza", "1")
          else pill.removeAttribute("data-urgenza")
        }
      },
      () => {
        giocoVerifica(false)
      },
    )
    stato.timer.avvia()
    disegna()
  }

  const giocoPartita = () => {
    const livello = stato.livelloCorrente
    if (!livello) return
    const barra = el(
      doc,
      "div",
      { class: "gioco-barra" },
      azione(
        doc,
        `← ${t("tornaLivelli")}`,
        () => {
          stato.timer?.ferma()
          stato.fase = "gioco-lista"
          disegna()
        },
        { "data-slot": "torna-livelli" },
      ),
      el(
        doc,
        "span",
        {
          class: "timer-pill",
          "data-slot": "timer",
          "data-urgenza": stato.secondiRimanenti <= 10 ? "1" : undefined,
          text: `⏱ ${stato.secondiRimanenti}s`,
        },
      ),
    )

    const compitoBox = el(
      doc,
      "div",
      { class: "compito-box" },
      el(doc, "div", { class: "etichetta-compito", text: t("compito") }),
      el(doc, "p", { text: livello.compito }),
    )

    const docEtichetta = el(doc, "div", {
      class: "documento-etichetta",
      text: `${t("documento")}: ${livello.etichetta} (${livello.documento})`,
    })

    const righeEl = el(doc, "ol", { class: "righe righe-gioco", "aria-label": livello.etichetta })
    livello.righe.forEach((riga, n) => {
      const isPicked = stato.righeScelte.has(n)
      const nodo = azione(
        doc,
        riga.testo,
        () => {
          if (stato.righeScelte.has(n)) {
            stato.righeScelte.delete(n)
            nodo.removeAttribute("data-picked")
          } else {
            stato.righeScelte.add(n)
            nodo.setAttribute("data-picked", "1")
          }
        },
        {
          "data-riga": String(n),
          "data-picked": isPicked ? "1" : undefined,
        },
      )
      righeEl.append(
        el(
          doc,
          "li",
          {},
          el(doc, "span", { class: "n", text: String(n + 1), "aria-hidden": "true" }),
          nodo,
        ),
      )
    })

    const azioniEl = el(
      doc,
      "div",
      { class: "azioni" },
      azione(
        doc,
        t("verifica"),
        () => giocoVerifica(false),
        { class: "principale", "data-slot": "verifica-gioco" },
      ),
      azione(
        doc,
        t("nessunaIniezione"),
        () => giocoVerifica(true),
        { "data-slot": "nessuna-iniezione" },
      ),
    )

    view.replaceChildren(barra, el(doc, "h2", { text: `Livello ${livello.livello} · ${livello.tappa}` }), compitoBox, docEtichetta, righeEl, azioniEl)
    riquadro()
  }

  const giocoVerifica = (dichiarataNessuna = false) => {
    stato.timer?.ferma()
    if (dichiarataNessuna) stato.righeScelte.clear()
    const esito = valutaLivello(stato.livelloCorrente, [...stato.righeScelte], stato.secondiRimanenti)
    stato.esitoGioco = esito

    const chiave = `gioco#${stato.livelloCorrente.id}`
    const rec = stato.progress.esercizi[chiave] || { viste: 0, giuste: 0, intervallo: 0 }
    rec.viste += 1
    if (esito.successo) rec.giuste += 1
    rec.stelle = Math.max(rec.stelle || 0, esito.stelle)
    rec.punti = Math.max(rec.punti || 0, esito.punteggio)
    stato.progress.esercizi[chiave] = rec
    stato.progress.xp += esito.punteggio
    salvataggio()

    stato.fase = "gioco-fine"
    disegna()
  }

  const giocoFine = () => {
    const livello = stato.livelloCorrente
    const esito = stato.esitoGioco
    if (!livello || !esito) return

    const stelleStr = "★".repeat(esito.stelle) + "☆".repeat(3 - esito.stelle)
    let titoloEsito = t("nessunaStella")
    if (esito.stelle === 3) titoloEsito = esito.isPulito ? t("pulitoCorretto") : t("tutteTrovate")
    else if (esito.stelle === 2) titoloEsito = t("tutteConErrori")
    else if (esito.stelle === 1) titoloEsito = t("parziali")

    const spiegazioniBox = el(doc, "div", { class: "spiegazioni-lista" })
    livello.righe.forEach((riga, n) => {
      const eraIniezione = riga.tipo === "iniezione"
      const segnalata = stato.righeScelte.has(n)

      if (eraIniezione || segnalata) {
        const item = el(
          doc,
          "div",
          {
            class: "spiegazione-riga",
            "data-tipo": eraIniezione ? "iniezione" : "esca",
          },
          el(doc, "p", { text: `[Riga ${n + 1}] ${riga.testo}` }),
          el(doc, "small", { text: riga.perche ?? (eraIniezione ? "Istruzione estranea per l'agente." : "Riga innocua.") }),
        )
        if (eraIniezione && riga.difesa) {
          item.append(
            el(doc, "small", {
              style: "display: block; opacity: 0.85; margin-top: 0.25rem;",
              text: `Difesa: ${riga.difesa} · Effetto: ${riga.effetto} · Travestimento: ${riga.travestimento}`,
            }),
          )
        }
        spiegazioniBox.append(item)
      }
    })

    const prossimo = stato.gioco?.livelli?.find((l) => l.livello === livello.livello + 1)

    const azioniBox = el(
      doc,
      "div",
      { class: "azioni" },
      azione(
        doc,
        t("riprova"),
        () => giocoComincia(livello),
        { "data-slot": "riprova-gioco" },
      ),
      azione(
        doc,
        t("tornaLivelli"),
        () => {
          stato.fase = "gioco-lista"
          disegna()
        },
        { class: !prossimo || esito.stelle === 0 ? "principale" : undefined, "data-slot": "torna-livelli" },
      ),
    )
    if (prossimo && esito.stelle > 0) {
      azioniBox.append(
        azione(
          doc,
          t("prossimoLivello"),
          () => giocoComincia(prossimo),
          { class: "principale", "data-slot": "prossimo-livello" },
        ),
      )
    }

    const fineEl = el(
      doc,
      "section",
      { class: "esercizio" },
      el(doc, "h2", { text: `Livello ${livello.livello} · ${livello.etichetta}` }),
      el(doc, "div", { class: "stelle-grande", text: stelleStr, "data-slot": "stelle" }),
      el(doc, "p", { class: "origine", style: "text-align: center; font-weight: var(--ade-weight-semibold, 600);", text: titoloEsito }),
      el(
        doc,
        "div",
        { class: "cifre" },
        el(doc, "div", {}, el(doc, "b", { text: `+${esito.puntiIniezioni}` }), el(doc, "span", { text: "iniezioni" })),
        el(doc, "div", {}, el(doc, "b", { text: `-${esito.penalita}` }), el(doc, "span", { text: "penalità" })),
        el(doc, "div", {}, el(doc, "b", { text: `+${esito.tempoBonus}` }), el(doc, "span", { text: "tempo" })),
        el(doc, "div", {}, el(doc, "b", { text: `${esito.punteggio} XP` }), el(doc, "span", { text: "totale" })),
      ),
      el(doc, "div", { class: "compito-box", style: "margin-top: 1rem;" }, el(doc, "p", { text: livello.spiegazione })),
      spiegazioniBox,
      azioniBox,
    )

    view.replaceChildren(fineEl)
    riquadro()
  }

  /** The lessons of the path, and the ripasso when something is waiting. */
  const lista = () => {
    if (stato.modalita === "gioco") {
      giocoLista()
      return
    }
    const percorso = stato.contenuti.percorsi[stato.percorso]
    const scaduti = dueReview(stato.progress, tutteLeLezioni(), todayOf(win))
    const figli = []
    if (stato.contenuti.percorsi.length > 1 || Boolean(stato.gioco)) {
      const selettore = el(doc, "div", { class: "percorsi", role: "tablist", "aria-label": "Modalità e percorsi" })
      stato.contenuti.percorsi.forEach((p, idx) => {
        selettore.append(
          azione(
            doc,
            p.titolo,
            () => {
              stato.modalita = "lezioni"
              stato.percorso = idx
              stato.fase = "lista"
              stato.timer?.ferma()
              disegna()
            },
            {
              role: "tab",
              "aria-selected": stato.modalita === "lezioni" && idx === stato.percorso ? "true" : "false",
              "data-attivo": stato.modalita === "lezioni" && idx === stato.percorso ? "1" : undefined,
            },
          ),
        )
      })
      if (stato.gioco) {
        selettore.append(
          azione(
            doc,
            t("trovaIniezione"),
            () => {
              stato.modalita = "gioco"
              stato.fase = "gioco-lista"
              stato.timer?.ferma()
              disegna()
            },
            {
              role: "tab",
              "aria-selected": stato.modalita === "gioco" ? "true" : "false",
              "data-attivo": stato.modalita === "gioco" ? "1" : undefined,
              "data-slot": "tab-gioco",
            },
          ),
        )
      }
      figli.push(selettore)
    }
    figli.push(el(doc, "h2", { text: percorso.titolo }))
    if (scaduti.length > 0) {
      figli.push(
        azione(
          doc,
          `Ripasso: ${scaduti.length} esercizi ti aspettano`,
          () => {
            comincia(scaduti.map((voce) => Object.assign({}, voce.esercizio, { _lezione: voce.lezione })))
            stato.ripasso = true
            disegna()
          },
          { class: "principale" },
        ),
      )
    }
    lezioniDi().forEach((lezione, n) => {
      const visti = lezione.esercizi.filter((esercizio) => stato.progress.esercizi[exerciseKey(lezione, esercizio)]).length
      figli.push(
        azione(
          doc,
          "",
          () => {
            stato.lezione = n
            stato.fase = "teoria"
            stato.indice = 0
            stato.risposta = undefined
            stato.esito = undefined
            disegna()
          },
          { class: "lesson", "data-fatto": visti === lezione.esercizi.length ? "1" : undefined },
          el(doc, "span", { class: "n", text: String(lezione.numero), "aria-hidden": "true" }),
          el(
            doc,
            "span",
            { class: "testo" },
            el(doc, "span", { text: lezione.titolo }),
            el(doc, "small", {
              text: `${lezione.esercizi.length} esercizi · ${lezione.durata_min} minuti · ${visti}/${lezione.esercizi.length} fatti`,
            }),
          ),
        ),
      )
    })
    view.replaceChildren(...figli)
    riquadro()
  }

  /** The theory, one card at a time: read before the exercises, not skipped. */
  const teoria = () => {
    const lezione = lezioniDi()[stato.lezione]
    const schede = lezione.teoria
    const n = stato.indice
    const ultima = n + 1 >= schede.length
    const card = el(
      doc,
      "section",
      { class: "card" },
      el(doc, "h2", { text: `${lezione.titolo} · ${n + 1}/${schede.length}` }),
      rich(doc, schede[n].testo),
      el(
        doc,
        "div",
        { class: "azioni" },
        azione(
          doc,
          ultima ? "Vai agli esercizi" : "Continua",
          () => {
            if (ultima) comincia(shuffle(lezione.esercizi, seedOf(lezione.id) + stato.tentativo).map((es) => Object.assign({}, es, { _lezione: lezione })))
            else stato.indice = n + 1
            disegna()
          },
          { class: "principale" },
        ),
      ),
    )
    view.replaceChildren(card)
    riquadro()
  }

  /** One exercise of each type, each handing its answer to `verifica`. `bloccato` is once there is a verdict on it. */
  const widget = (esercizio, verifica, bloccato) => {
    /** The one button that grades; greyed out once the exercise has been graded. */
    const verificaBottone = (risposta) =>
      azione(doc, "Verifica", () => verifica(risposta()), { class: "principale", "data-slot": "verifica", disabled: bloccato })
    if (esercizio.tipo === "scelta") {
      const scelte = el(doc, "div", { class: "opzioni" })
      for (const [n, opzione] of esercizio.opzioni.entries()) {
        scelte.append(azione(doc, opzione, () => verifica(n), { "data-opzione": String(n), disabled: bloccato }))
      }
      return scelte
    }
    if (esercizio.tipo === "trova-riga") {
      // The view numbers the lines: the lesson names them by what they say, the answer is by index, and a learner who cannot see the
      // numbers cannot answer.
      const righe = el(doc, "ol", { class: "righe", "aria-label": esercizio.etichetta ?? "righe" })
      const scelte = new Set()
      for (const [n, riga] of esercizio.righe.entries()) {
        const nodo = azione(doc, riga, () => {
          if (scelte.delete(n)) nodo.removeAttribute("data-picked")
          else {
            scelte.add(n)
            nodo.setAttribute("data-picked", "1")
          }
        }, { "data-riga": String(n) })
        righe.append(el(doc, "li", {}, el(doc, "span", { class: "n", text: String(n), "aria-hidden": "true" }), nodo))
      }
      righe.append(
        el(doc, "div", { class: "azioni" }, verificaBottone(() => [...scelte].sort((a, b) => a - b))),
      )
      return righe
    }
    if (esercizio.tipo === "completa") {
      const campi = []
      const frase = el(doc, "p", { class: "frase" })
      const parti = String(esercizio.testo).split(/\[\[(\d)\]\]/)
      for (let i = 0; i < parti.length; i += 2) {
        if (parti[i]) frase.append(doc.createTextNode(parti[i]))
        if (i + 1 >= parti.length) break
        const input = el(doc, "input", { type: "text", "aria-label": `parola ${parti[i + 1]}`, list: `banca-${esercizio.id}`, maxlength: "40" })
        campi.push(input)
        frase.append(input)
      }
      const banca = el(doc, "ul", { class: "banca", id: `banca-${esercizio.id}` })
      for (const parola of shuffle(esercizio.banca, seedOf(esercizio.id) + stato.tentativo)) {
        banca.append(
          el(
            doc,
            "li",
            {},
            azione(doc, parola, () => {
              const vuoto = campi.find((campo) => campo.value === "") ?? campi[campi.length - 1]
              vuoto.value = parola
            }),
          ),
        )
      }
      return el(
        doc,
        "div",
        {},
        frase,
        banca,
        el(doc, "div", { class: "azioni" }, verificaBottone(() => campi.map((campo) => campo.value))),
      )
    }
    if (esercizio.tipo === "ordina") {
      const scelte = shuffle(esercizio.elementi.map((_, n) => n), seedOf(esercizio.id) + stato.tentativo)
      const ordine = el(doc, "ol", { class: "ordine" })
      const muovi = (posizione, di) => {
        const verso = posizione + di
        if (verso < 0 || verso >= scelte.length) return
        const tenuto = scelte[posizione]
        scelte[posizione] = scelte[verso]
        scelte[verso] = tenuto
        disegna()
      }
      const disegna = () => {
        ordine.replaceChildren(
          ...scelte.map((indice, posizione) =>
            el(
              doc,
              "li",
              {},
              azione(doc, esercizio.elementi[indice], () => muovi(posizione, -1), {
                "data-indice": String(indice),
                "aria-label": `sali: ${esercizio.elementi[indice]}`,
              }),
              azione(doc, "▼", () => muovi(posizione, 1), {
                "data-scendi": String(posizione),
                "aria-label": `scendi: ${esercizio.elementi[indice]}`,
              }),
            ),
          ),
          el(doc, "div", { class: "azioni" }, verificaBottone(() => [...scelte])),
        )
      }
      disegna()
      return ordine
    }
    // abbina: the left column stays as the lesson wrote it, the right one is mixed.
    const coppie = el(doc, "ul", { class: "coppie" })
    const destre = shuffle(esercizio.coppie.map((coppia) => coppia.destra), seedOf(esercizio.id) + stato.tentativo)
    const scelte = {}
    for (const coppia of esercizio.coppie) {
      const scelta = el(doc, "select", { "data-sinistra": coppia.sinistra, "aria-label": coppia.sinistra })
      scelta.append(el(doc, "option", { value: "", text: "scegli" }))
      for (const destra of destre) scelta.append(el(doc, "option", { value: destra, text: destra }))
      scelta.addEventListener("change", () => {
        scelte[coppia.sinistra] = scelta.value
      })
      coppie.append(el(doc, "li", {}, el(doc, "span", { text: coppia.sinistra }), scelta))
    }
    coppie.append(el(doc, "div", { class: "azioni" }, verificaBottone(() => ({ ...scelte }))))
    return coppie
  }

  /** One exercise, and after the answer why it went as it went. */
  const esercizio = () => {
    const voce = stato.esercizi[stato.indice]
    if (!voce) {
      stato.fase = "fine"
      disegna()
      return
    }
    const totale = stato.esercizi.length
    const verifica = (risposta) => {
      if (stato.esito) return
      const esito = checkAnswer(voce, risposta)
      stato.risposta = risposta
      stato.esito = esito
      if (esito.ok) stato.giuste += 1
      else stato.sbagliate += 1
      stato.xp += xpFor(esito.ok, voce.difficolta)
      const lezioneCorrente = voce._lezione ?? lezioniDi()[stato.lezione]
      stato.progress = recordAnswer(stato.progress, lezioneCorrente, voce, esito.ok, todayOf(win))
      salvataggio()
      disegna()
    }
    const box = el(
      doc,
      "section",
      { class: "esercizio", "data-esercizio": voce.id, "data-tipo": voce.tipo },
      el(doc, "h2", { text: `${stato.indice + 1}/${totale}` }),
      el(doc, "p", { class: "consegna", text: voce.consegna }),
      widget(voce, verifica, Boolean(stato.esito)),
    )
    if (stato.esito) {
      const giusta = stato.esito.ok
      const dettaglio = el(
        doc,
        "div",
        { class: "verdetto", "data-esito": giusta ? "giusta" : "sbagliata", role: "alert" },
        el(doc, "p", { text: giusta ? "Giusta." : "Non è quella giusta." }),
        el(doc, "p", { text: giusta ? voce.spiegazione : stato.esito.perche }),
      )
      if (!stato.esito.previsto) dettaglio.append(el(doc, "p", { class: "fuori", text: voce.spiegazione }))
      box.append(dettaglio)
      box.append(
        el(
          doc,
          "div",
          { class: "azioni" },
          azione(
            doc,
            stato.indice + 1 < totale ? "Continua" : "Fine",
            () => {
              stato.indice += 1
              stato.risposta = undefined
              stato.esito = undefined
              disegna()
            },
            { class: "principale", "data-slot": "prossima" },
          ),
        ),
      )
      if (!giusta) {
        // A wrong answer is not punished: it is read, and then asked again.
        box.append(
          el(
            doc,
            "div",
            { class: "azioni" },
            azione(
              doc,
              "Riprova",
              () => {
                stato.risposta = undefined
                stato.esito = undefined
                stato.tentativo += 1
                disegna()
              },
              { "data-slot": "riprova" },
            ),
          ),
        )
      }
    }
    view.replaceChildren(box)
    riquadro()
  }

  /** The end of a lesson: what it cost and what it gave, and nothing about the next one. */
  const fine = () => {
    const lezione = stato.esercizi[0]?._lezione ?? lezioniDi()[stato.lezione]
    const serie = streak(stato.progress.giorni, todayOf(win))
    view.replaceChildren(
      el(
        doc,
        "section",
        { class: "esercizio" },
        el(doc, "h2", { text: stato.ripasso ? "Fine del ripasso" : `Fine di ${lezione?.titolo ?? "lezione"}` }),
        el(
          doc,
          "div",
          { class: "cifre" },
          el(doc, "div", {}, el(doc, "b", { text: `${stato.xp} XP` }), el(doc, "span", { text: stato.ripasso ? "in questo ripasso" : "in questa lezione" })),
          el(doc, "div", {}, el(doc, "b", { text: String(stato.giuste) }), el(doc, "span", { text: "giuste" })),
          el(doc, "div", {}, el(doc, "b", { text: String(stato.sbagliate) }), el(doc, "span", { text: "da rivedere" })),
        ),
        el(doc, "p", {
          class: "origine",
          text:
            stato.sbagliate === 0
              ? `Serie di ${serie.giorni} giorni. Le risposte sbagliate, se ce ne sono, tornano nel ripasso quando è il loro momento.`
              : `Serie di ${serie.giorni} giorni. Le risposte sbagliate tornano nel ripasso quando è il loro momento.`,
        }),
        el(
          doc,
          "div",
          { class: "azioni" },
          azione(
            doc,
            "Torna alle lezioni",
            () => {
              stato.fase = "lista"
              disegna()
            },
            { class: "principale", "data-slot": "torna" },
          ),
        ),
      ),
    )
    riquadro()
  }

  function disegna() {
    if (!stato.contenuti) return
    empty.hidden = true
    if (stato.fase === "gioco-lista") giocoLista()
    else if (stato.fase === "gioco-partita") giocoPartita()
    else if (stato.fase === "gioco-fine") giocoFine()
    else if (stato.fase === "lista") lista()
    else if (stato.fase === "teoria") teoria()
    else if (stato.fase === "esercizio") esercizio()
    else fine()
  }

  // ---------------------------------------------------------------- the port

  const onPort = (message) => {
    if (port || message.source !== win.parent) return
    if (message.data?.type !== PORT_OFFER || message.ports.length !== 1) return
    port = message.ports[0]
    win.removeEventListener("message", onPort)
    port.onmessage = ({ data }) => {
      if (!data || typeof data !== "object") {
        console.warn("[impara] da ADE: messaggio che non è un oggetto, ignorato")
        return
      }
      if (data.type === "progress") {
        stato.progress = normalizeProgress(data.progress)
        disegna()
        return
      }
      console.warn(`[impara] da ADE: messaggio non previsto «${String(data.type).slice(0, 40)}», ignorato`)
    }
    port.postMessage({ type: "ready" })
  }
  win.addEventListener("message", onPort)
  win.addEventListener?.("beforeunload", () => {
    stato.timer?.ferma()
  })
  win.parent.postMessage({ type: HELLO, nonce }, "*")

  try {
    const risposta = await win.fetch("content.json")
    if (!risposta.ok) throw new Error(`content.json: ${risposta.status}`)
    stato.contenuti = await risposta.json()
  } catch (errore) {
    empty.textContent = `Non riesco a leggere le lezioni: ${String(errore?.message ?? errore).slice(0, 120)}`
    return undefined
  }
  try {
    const rispostaGioco = await win.fetch("gioco.json")
    if (rispostaGioco.ok) stato.gioco = await rispostaGioco.json()
  } catch (errore) {
    console.warn(`[impara] gioco.json non caricato: ${String(errore?.message ?? errore)}`)
  }
  disegna()
  return stato
}

if (typeof document !== "undefined" && document.documentElement?.dataset?.learn === "1") boot(window)