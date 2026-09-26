import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createPanelRouter, createPendingPanelReplies, dictationHold, panelReplyHold, PANEL_REPLY_MAX_AGE_MS, ECHO_WINDOW_MS, REPEAT_WINDOW_MS, type HandledRequest, type PanelHandler } from "./router"
import { isQuestionOpen } from "../session/mailbox"
import { REPLY_PREFIX } from "./protocol"

const replyOf = (handled: HandledRequest | undefined) => (handled && "reply" in handled ? handled.reply : undefined)

const VERBS = [{ name: "play", usage: "play", summary: "avvia" }] as const

/** A panel that records what it was asked and answers as told. */
function panel(answer: PanelHandler["run"]): PanelHandler & { asked: string[] } {
  const asked: string[] = []
  return {
    asked,
    verbs: VERBS,
    run: (request) => {
      asked.push(`${request.verb} ${request.args.join(" ")}`.trim())
      return answer(request)
    },
  }
}

describe("createPanelRouter", () => {
  test("an ordinary line of output is not a request", async () => {
    const router = createPanelRouter()
    router.register("video", panel(async () => ({ ok: true, detail: "fatto" })))

    expect(await router.handle("Compiled 3 modules in 412ms")).toBeUndefined()
    // Including a line that talks *about* the protocol without being one.
    expect(await router.handle("puoi scrivere @ade video play per avviarlo")).toBeUndefined()
  })

  test("a request reaches the panel it names, and the reply says what happened", async () => {
    const router = createPanelRouter()
    const video = panel(async () => ({ ok: true, detail: "0:12.0 di 1:40.0, in riproduzione" }))
    router.register("video", video)

    const handled = await router.handle("@ade video seek 12")
    expect(video.asked).toEqual(["seek 12"])
    expect(replyOf(handled)).toBe(`${REPLY_PREFIX} video seek ok — 0:12.0 di 1:40.0, in riproduzione`)
  })

  test("the panel is told which session asked", async () => {
    const router = createPanelRouter()
    const from: (string | undefined)[] = []
    router.register("browser", {
      verbs: VERBS,
      run: async (_request, who) => {
        from.push(who)
        return { ok: true, detail: "" }
      },
    })
    await router.handle("@ade browser reload", "n1-2")
    await router.handle("@ade browser state")
    expect(from).toEqual(["n1-2", undefined])
  })

  test("a panel that is not open is told so, with the ones that are", async () => {
    const router = createPanelRouter()
    router.register("video", panel(async () => ({ ok: true, detail: "" })))

    const handled = await router.handle("@ade 3d rotate 90")
    /*
     * The failure this prevents: answering "ok" for a panel nobody is
     * showing. The agent would go on reasoning about a view that does not
     * exist, and nothing in the interface would contradict it.
     */
    expect(replyOf(handled)).toContain("errore")
    expect(replyOf(handled)).toContain("«3d» non è aperto")
    expect(replyOf(handled)).toContain("video")
  })

  test("with nothing open at all it says that instead of listing an empty set", async () => {
    const router = createPanelRouter()
    const handled = await router.handle("@ade video play")
    expect(replyOf(handled)).toContain("nessun pannello aperto")
  })

  test("a panel that throws still answers, because the agent is blocked on the line", async () => {
    const router = createPanelRouter()
    router.register(
      "video",
      panel(() => Promise.reject(new Error("il file non è leggibile"))),
    )

    const handled = await router.handle("@ade video play")
    expect(replyOf(handled)).toBe(`${REPLY_PREFIX} video play errore — il file non è leggibile`)
  })

  test("a closed panel stops answering", async () => {
    const router = createPanelRouter()
    router.register("video", panel(async () => ({ ok: true, detail: "fatto" })))
    expect(router.open()).toEqual(["video"])

    router.unregister("video")
    expect(router.open()).toEqual([])
    const handled = await router.handle("@ade video play")
    expect(replyOf(handled)).toContain("errore")
  })

  test("the reply ADE typed is never read back as a new request", async () => {
    const router = createPanelRouter()
    const video = panel(async () => ({ ok: true, detail: "fatto" }))
    router.register("video", video)

    // The terminal echoes what ADE writes; taking that for a request would be
    // a loop with no exit.
    const first = await router.handle("@ade video play")
    expect(first).toBeDefined()
    expect(await router.handle(replyOf(first)!)).toBeUndefined()
    expect(video.asked).toEqual(["play"])
  })

  test("a request a TUI keeps redrawing runs once, and the skip is said once (agy loop, 0.5.0 trial)", async () => {
    const router = createPanelRouter()
    const model = panel(async () => ({ ok: false, reason: "formato non supportato" }))
    router.register("model", model)

    const line = "@ade model open <percorso> — apre un modello 3D del progetto"
    const t = 1_000_000
    expect(replyOf(await router.handle(line, "agy", t))).toContain("errore")
    // A hook busy caused by typing that reply is not a new turn.
    router.newTurn("agy", t + 3000)
    // The reply typed back makes agy redraw the screen, and the same line comes again.
    const skipped = await router.handle(line, "agy", t + 2000)
    expect(skipped && "skipped" in skipped ? skipped.skipped : "").toStartWith("Riga non eseguita: @ade model open")
    for (let i = 2; i <= 5; i++) expect(await router.handle(line, "agy", t + i * 2000)).toBeUndefined()
    expect(model.asked).toHaveLength(1)
    // Another session writing the same line is its own request.
    expect(replyOf(await router.handle(line, "claude", t + 12_000))).toBeDefined()
    // Once the line has stopped coming back, writing it again is a new request.
    expect(replyOf(await router.handle(line, "agy", t + 11_000 + REPEAT_WINDOW_MS))).toBeDefined()
    expect(model.asked).toHaveLength(3)
  })

  test("a slow panel's reply still keeps its own busy from counting as a new turn", async () => {
    let clock = 0
    const router = createPanelRouter(() => clock)
    const model = panel(async () => {
      clock += 6000
      return { ok: true, detail: "catturato" }
    })
    router.register("model", model)

    const t = 1_000_000
    expect(replyOf(await router.handle("@ade model capture", "agy", t))).toBeDefined()
    // The reply was typed 6 s after the request; its busy arrives 3 s later.
    router.newTurn("agy", t + 9000)
    await router.handle("@ade model capture", "agy", t + 10_000)
    expect(model.asked).toEqual(["capture"])
  })

  test("state, view, state across turns all run", async () => {
    const router = createPanelRouter()
    const model = panel(async () => ({ ok: true, detail: "" }))
    router.register("model", model)

    const t = 1_000_000
    expect(replyOf(await router.handle("@ade model state", "s", t))).toBeDefined()
    router.newTurn("s", t + 8000)
    expect(replyOf(await router.handle("@ade model view front", "s", t + 9000))).toBeDefined()
    router.newTurn("s", t + 16_000)
    expect(replyOf(await router.handle("@ade model state", "s", t + 17_000))).toBeDefined()
    expect(model.asked).toEqual(["state", "view front", "state"])
  })

  test("text ADE just typed into a session is not run when its TUI echoes it, and only just", async () => {
    const router = createPanelRouter()
    const model = panel(async () => ({ ok: true, detail: "" }))
    router.register("model", model)

    const t = 1_000_000
    router.typed("s1", '[Messaggio da "Voice"]: prova   @ade model state   e dimmi', t)
    const echo = await router.handle("@ade model state", "s1", t + 500)
    expect(echo && "skipped" in echo ? echo.skipped : "").toContain("eco")
    // The same line written by the agent of a session ADE typed nothing into runs.
    expect(replyOf(await router.handle("@ade model state", "s2", t + 500))).toBeDefined()
    // A quote from minutes ago does not swallow the agent writing the line now.
    router.typed("s3", "cita @ade model state", t)
    expect(replyOf(await router.handle("@ade model state", "s3", t + ECHO_WINDOW_MS))).toBeDefined()
    expect(model.asked).toEqual(["state", "state"])
  })

  test("opening a panel types nothing into the sessions (six prompts queued in Claude Code, 0.5.0 trial)", () => {
    const source = readFileSync(join(import.meta.dir, "..", "surface", "workbench.tsx"), "utf8")
    const start = source.indexOf("const announcePanels = ")
    expect(start).toBeGreaterThan(-1)
    const body = source.slice(start, source.indexOf("\n  }\n", start))
    expect(body).toContain("panels.greeting(panel)")
    expect(body).not.toMatch(/\.write\(|typeLine|asSubmittedLine/)
  })

  test("the greeting describes the panel that is open, and nothing when none is", () => {
    const router = createPanelRouter()
    expect(router.greeting("video")).toEqual([])

    router.register("video", panel(async () => ({ ok: true, detail: "" })))
    const lines = router.greeting("video")
    expect(lines.length).toBeGreaterThan(2)
    // Every line is prefixed, so the greeting cannot be read back as requests.
    expect(lines.every((line) => line.startsWith(REPLY_PREFIX))).toBe(true)
    expect(lines.join("\n")).toContain("play")
  })
})

/*
 * A panel's answer used to go into the pty with its Enter, past the line queue,
 * past the draft check and past the permission check. So an agent that printed
 * an `@ade` line and then asked for a permission had its answer typed over the
 * prompt and confirmed the selected choice — and where the options are numbered,
 * a reply that begins with a digit picks one of them instead. It was there
 * before P1 and P1 did not touch it: the hook made the state right and this road
 * never asked the state.
 */
describe("a panel reply waits for the pane like any other line", () => {
  const now = Date.now()
  const hookSaysPermission = { state: "permission" as const, at: now }
  const held = (over: Partial<{ alive: boolean; typing: boolean; questionOpen: boolean }> = {}) =>
    panelReplyHold({ alive: true, typing: false, questionOpen: false, ...over })

  test("a prompt only the hook knows about holds the reply", () => {
    // The screen saw nothing, the hook said there is a question: the reply waits.
    const questionOpen = isQuestionOpen(undefined, hookSaysPermission)
    expect(questionOpen).toBe(true)
    expect(held({ questionOpen })).toBe("prompt aperto")
    // The same prompt found by reading the screen holds it too, as it always did.
    expect(held({ questionOpen: isQuestionOpen({ what: "Bash(rm -rf)" }, undefined) })).toBe("prompt aperto")
  })

  test("a line the user began holds it, and a session that is gone ends it", () => {
    expect(held({ typing: true })).toBe("riga iniziata")
    // Both at once: the user's own line is the nearer reason.
    expect(held({ typing: true, questionOpen: true })).toBe("riga iniziata")
    // A session that went away cannot be typed into, and there is nobody to
    // retry for: the reply is dropped rather than kept for a pane that is not there.
    expect(panelReplyHold({ alive: false, typing: false, questionOpen: false })).toBe("sessione chiusa")
  })

  test("a free pane is given the reply, as before", () => {
    expect(held()).toBeUndefined()
    // A turn in progress is not a question: the reply goes in, behind the queue.
    expect(held({ questionOpen: isQuestionOpen(undefined, { state: "busy", at: now }) })).toBeUndefined()
  })
})

describe("dictated words are not written over a question", () => {
  const now = Date.now()
  const asking = () => isQuestionOpen(undefined, { state: "permission" as const, at: now })

  test("a prompt only the hook knows about holds the dictation", () => {
    expect(asking()).toBe(true)
    expect(dictationHold({ alive: true, questionOpen: asking() })).toBe("prompt aperto")
    // The screen's own reading holds it too, as it always did for the Enter.
    expect(dictationHold({ alive: true, questionOpen: isQuestionOpen({ what: "Bash" }, undefined) })).toBe("prompt aperto")
  })

  test("with no question the words are written, as before", () => {
    expect(dictationHold({ alive: true, questionOpen: false })).toBeUndefined()
    // A turn in progress is not a question, and dictation has always been allowed
    // into a line the user has begun: neither is what this guard is about.
    expect(dictationHold({ alive: true, questionOpen: isQuestionOpen(undefined, { state: "busy", at: now }) })).toBeUndefined()
    expect(dictationHold({ alive: false, questionOpen: false })).toBe("sessione chiusa")
  })
})
/*
 * M1 and M2, from the review of `ade/pannello-guardia`.
 *
 * M1 was a condition written backwards: the answer was deleted from the waiting
 * and then the code asked whether it was still there, so a reply that could not
 * be given — a prompt opened between the check and the queue — was dropped
 * instead of retried, which is the opposite of what the comment promised. The
 * store is a module and not a map in the component because that condition is
 * exactly the kind of thing a test has to be able to reach.
 */
describe("the answers waiting for a pane", () => {
  const now = 1_000_000
  const first = { id: "proc-1" }
  const restarted = { id: "proc-2" }

  test("an answer that could not be given goes back to the waiting (M1)", () => {
    const store = createPendingPanelReplies<{ id: string }>()
    store.queue("p1", first, "Va bene", now)
    // What `handlePanelRequest` does before typing: out of the waiting, so the
    // round cannot send it twice.
    expect(store.take("p1", "Va bene")).toBe(true)
    expect(store.waiting("p1")).toEqual([])
    // And after a try that did not give it, which is what the reversed condition
    // threw away: back it goes, or the agent waits for an answer that never comes.
    store.restore("p1", first, "Va bene", now)
    expect(store.waiting("p1").map((wait) => wait.text)).toEqual(["Va bene"])
    // Given this time: taken for the send and not restored.
    expect(store.take("p1", "Va bene")).toBe(true)
    expect(store.waiting("p1")).toEqual([])
    // A try that is still in flight when the pane restarts: the answer comes
    // back to a pane that is no longer the one that asked, and is not restored.
    store.restore("p1", first, "In volo", now)
    store.queue("p1", restarted, "Altra", now)
    store.restore("p1", first, "In volo", now)
    expect(store.waiting("p1").map((wait) => wait.text)).toEqual(["Altra"])
  })

  test("a pane that was restarted is not the session that asked (M2)", () => {
    const store = createPendingPanelReplies<{ id: string }>()
    store.queue("p1", first, "Va bene", now)
    // The pane still answers to `p1`, so a lookup by id alone finds this process.
    expect(store.sessionOf("p1")).toBe(first)
    // The comparison the flush makes, and the pane was restarted meanwhile.
    expect(restarted === store.sessionOf("p1")).toBe(false)
    // So the answers go: they were for a process that is gone, and typing them
    // here would start a turn in a session that never asked.
    store.forget("p1")
    expect(store.panes()).toEqual([])
    // And a new answer from the new session is not mixed with the old ones.
    store.queue("p1", restarted, "Diverso", now)
    expect(store.waiting("p1").map((wait) => wait.text)).toEqual(["Diverso"])
    expect(store.sessionOf("p1")).toBe(restarted)
  })

  test("two answers in a row are two answers, in the order they were made", () => {
    const store = createPendingPanelReplies<{ id: string }>()
    store.queue("p1", first, "Prima", now)
    store.queue("p1", first, "Poi", now + 10)
    expect(store.claim("p1", now + 20).waits.map((wait) => wait.text)).toEqual(["Prima", "Poi"])
    // A different session on the same pane replaces what was waiting, rather
    // than delivering the old process its answers.
    store.queue("p1", restarted, "Nuova sessione", now + 30)
    expect(store.waiting("p1").map((wait) => wait.text)).toEqual(["Nuova sessione"])
  })

  test("an answer that waited too long is given up, and the young ones stay", () => {
    const store = createPendingPanelReplies<{ id: string }>()
    store.queue("p1", first, "Vecchia", now)
    store.queue("p1", first, "Giovane", now + PANEL_REPLY_MAX_AGE_MS - 1_000)
    // A pane busy for an hour: ageing happens on the way out, so waiting does
    // not keep an answer alive.
    const late = store.claim("p1", now + PANEL_REPLY_MAX_AGE_MS + 60_000)
    expect(late.stale).toBe(1)
    expect(late.waits.map((wait) => wait.text)).toEqual(["Giovane"])
    // A restore after a failed try keeps the age it was made at, so a reply
    // cannot be kept alive for ever by being retried.
    store.restore("p1", first, "Giovane", now + PANEL_REPLY_MAX_AGE_MS - 1_000)
    expect(store.claim("p1", now + PANEL_REPLY_MAX_AGE_MS * 2).stale).toBe(1)
    // Nothing left to wait for: the pane is out of the round entirely.
    expect(store.panes()).toEqual([])
  })
})
/*
 * I due BASSI sull'ordine, dalla delta di `12a442315`.
 *
 * Entrambi vengono da una lista che esiste per non perdere risposte e che si
 * poteva scavalcare: la strada diretta scriveva una risposta nuova davanti a
 * quelle in attesa, e il giro provava la successiva anche quando la prima tornava
 * indietro. Sono due casi rari — due righe `@ade` di fila e un prompt che si
 * apre e si chiude in mezzo — e sono due risposte lette nell'ordine sbagliato,
 * che per un agente è come ricevere risposte alle domande sbagliate.
 */
describe("l'ordine delle risposte di un pannello", () => {
  const now = 1_000_000
  const first = { id: "proc-1" }

  test("una risposta nuova non sorpassa quelle in attesa (BASSO 1)", () => {
    const store = createPendingPanelReplies<{ id: string }>()
    // Nothing waiting: the answer goes straight out, as it always did.
    expect(store.admit("p1", first, "Prima", now)).toBe(true)
    // A is held, B arrives while A is still waiting.
    store.queue("p1", first, "A", now + 1)
    // B is not written now, and not lost either: it is behind A.
    expect(store.admit("p1", first, "B", now + 2)).toBe(false)
    expect(store.waiting("p1").map((wait) => wait.text)).toEqual(["A", "B"])
    // The round writes them in the order they were made.
    expect(store.claim("p1", now + 3).waits.map((wait) => wait.text)).toEqual(["A", "B"])
  })

  test("una risposta trattenuta torna in fondo, ed e' per questo che il giro si ferma (BASSO 2)", () => {
    const store = createPendingPanelReplies<{ id: string }>()
    store.queue("p1", first, "A", now)
    store.queue("p1", first, "B", now + 1)
    const { waits } = store.claim("p1", now + 2)
    // The round takes the first and cannot give it: a prompt opened again.
    store.take("p1", "A")
    store.restore("p1", first, "A", waits[0]!.at)
    // A is at the end now, so B going through would arrive before it — which is
    // what the `break` in `flushPanelReplies` prevents. This is the state that
    // makes the break necessary, and the reason the `break` is not optional.
    expect(store.waiting("p1").map((wait) => wait.text)).toEqual(["B", "A"])
    // The next round starts from the top again, and the order it writes is the
    // order on the pane: the held one, because it is first to be tried.
    expect(store.claim("p1", now + 3).waits.map((wait) => wait.text)).toEqual(["B", "A"])
  })
})