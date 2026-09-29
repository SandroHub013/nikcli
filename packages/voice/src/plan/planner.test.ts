import { describe, expect, test } from "bun:test"
import { buildPlannerPrompt, extractJson, PLANNER_SYSTEM, plannerFailure, planUtterance, speechSoFar } from "./planner"
import { validatePlan, type PlanContext } from "./schema"

const context: PlanContext = {
  agents: [
    { id: "claude-code", label: "Claude Code", available: true },
    { id: "codex", label: "Codex", available: false },
  ],
  projects: [{ name: "nikcli", root: "C:/Users/x/nikcli", isOpen: true }],
  paneCount: 1,
  commands: ["palette.open"],
}

describe("buildPlannerPrompt", () => {
  /*
   * Senza il catalogo vero il modello inventa id plausibili, e il piano viene
   * poi rifiutato per un errore che nessuno gli aveva dato modo di evitare.
   */
  test("dice al modello cosa esiste davvero su questa macchina", () => {
    const { user } = buildPlannerPrompt("avvia due sessioni", context)

    expect(user).toContain("claude-code")
    expect(user).toContain("nikcli")
    expect(user).toContain("palette.open")
    // E cosa NON esiste, altrimenti lo propone e basta.
    expect(user).toContain("NON installato")
  })

  test("le regole non cambiano da una frase all'altra: un processo tenuto acceso le tiene una volta sola", () => {
    const one = buildPlannerPrompt("avvia due sessioni", context)
    const other = buildPlannerPrompt("apri il progetto ade", { ...context, paneCount: 3, activeProjectName: "ade" })
    expect(one.system).toBe(PLANNER_SYSTEM)
    expect(other.system).toBe(PLANNER_SYSTEM)
    // Quello che cambia sta nel messaggio, non nel prompt di sistema.
    expect(one.system).not.toContain("claude-code")
    expect(one.system).not.toContain("avvia due sessioni")
    expect(other.user).toContain("Progetto attivo: ade")
  })

  test("la frase dell'utente arriva intera, dopo i dati", () => {
    const { user } = buildPlannerPrompt("avvia 4 sessioni claude", context)
    expect(user.endsWith("Frase dell'utente: avvia 4 sessioni claude")).toBe(true)
  })

  test("i pannelli arrivano con numero, titolo, agente e stato, così «manda a Mimo» si risolve", () => {
    const { user } = buildPlannerPrompt("manda a Mimo: fai i test", {
      ...context,
      paneCount: 3,
      panes: [
        { index: 1, title: "Dario", agent: "claude-code", status: "working" },
        { index: 2, title: "Mimo", agent: "opencode", status: "waiting" },
        { index: 3, title: "Terminale", status: "error" },
      ],
    })
    expect(user).toContain("1 · Dario · claude-code · al lavoro")
    expect(user).toContain("2 · Mimo · opencode · in attesa di una risposta dell'utente")
    expect(user).toContain("3 · Terminale · in errore")
  })

  test("senza pannelli lo dice, invece di lasciare un elenco vuoto", () => {
    expect(buildPlannerPrompt("x", context).user).toContain("Pannelli (numero · titolo · agente · stato):\n- (nessuno)")
  })

  test("le regole insegnano a rimandare all'agente quello che non sanno fare, con una risposta vuota", () => {
    expect(PLANNER_SYSTEM).toContain('{"speech":"Ci penso.","steps":[],"agent":true}')
    expect(PLANNER_SYSTEM).toContain("paneIndex")
  })
})

describe("handoff", () => {
  test("agent:true nel piano chiede all'agente, con la frase breve come speech", () => {
    const plan = validatePlan({ speech: "Ci penso.", steps: [], agent: true }, context)
    expect(plan).toMatchObject({ speech: "Ci penso.", steps: [], handoff: true })
    expect(validatePlan({ speech: "Fatto.", steps: [] }, context).handoff).toBeUndefined()
  })

  test("le regole insegnano la frase e il segnale", () => {
    expect(PLANNER_SYSTEM).toContain('"agent":true')
  })
})

describe("speechSoFar", () => {
  test("vuoto finché speech non comincia", () => {
    expect(speechSoFar("")).toBe("")
    expect(speechSoFar('{"spe')).toBe("")
    expect(speechSoFar('{"speech":')).toBe("")
  })

  test("cresce con la risposta e si ferma alla virgoletta che chiude", () => {
    expect(speechSoFar('{"speech":"Apro')).toBe("Apro")
    expect(speechSoFar('{"speech":"Apro il progetto ade.","steps":[{"action":"open_project"')).toBe(
      "Apro il progetto ade.",
    )
  })

  test("toglie le sequenze di escape e non si ferma su una virgoletta con la barra", () => {
    expect(speechSoFar('{"speech":"Dici \\"ciao\\" a Mimo\\ne poi\\u00e8 fatto')).toBe(
      'Dici "ciao" a Mimo\ne poi\u00e8 fatto',
    )
  })

  test("una escape a metà non produce mezzo carattere", () => {
    expect(speechSoFar('{"speech":"a\\')).toBe("a")
    expect(speechSoFar('{"speech":"a\\u00')).toBe("a")
  })

  test("legge anche una risposta in un blocco di codice", () => {
    expect(speechSoFar('```json\n{ "speech" : "Ok.", "steps": [] }')).toBe("Ok.")
  })
})

describe("extractJson", () => {
  test("legge il JSON nudo", () => {
    expect(extractJson('[{"action":"run_command","command":"palette.open"}]')).toHaveLength(1)
  })

  /*
   * Istruito a rispondere nudo, un modello incornicia comunque abbastanza
   * spesso da rendere il rifiuto una funzione che sembra rotta all'utente.
   */
  test("legge il JSON dentro un blocco di codice", () => {
    expect(extractJson('```json\n[{"action":"focus_pane","paneIndex":1}]\n```')).toHaveLength(1)
  })

  test("legge il JSON preceduto da una frase", () => {
    expect(extractJson('Certo, ecco:\n[{"action":"focus_pane","paneIndex":1}]')).toHaveLength(1)
  })

  test("una risposta senza JSON resta senza JSON", () => {
    expect(extractJson("mi dispiace, non ho capito")).toBeUndefined()
  })
})

describe("planUtterance", () => {
  test("una frase composta diventa un piano validato", async () => {
    const result = await planUtterance("avvia due sessioni claude, una sul parser e una sui test", context, async () =>
      JSON.stringify([
        { action: "start_session", agent: "claude", task: "il parser" },
        { action: "start_session", agent: "claude", task: "i test" },
      ]),
    )

    expect(result.failure).toBeUndefined()
    expect(result.steps).toHaveLength(2)
    expect(result.refusals).toEqual([])
  })

  /*
   * Un array vuoto è il modello che dice «questa frase non chiede niente»,
   * ed è una risposta valida: trattarla come errore trasformerebbe ogni
   * parola captata per sbaglio dal microfono in un messaggio di errore.
   */
  test("«niente da fare» non è un guasto", async () => {
    const result = await planUtterance("mm, vediamo", context, async () => "[]")
    expect(result.failure).toBeUndefined()
    expect(result.steps).toEqual([])
    expect(result.refusals).toEqual([])
  })

  test("una chiamata che esplode diventa qualcosa da dire, non un'eccezione", async () => {
    const result = await planUtterance("qualsiasi cosa", context, async () => {
      throw new Error("Non riesco a pianificare: Claude Code non è installato.")
    })

    expect(result.steps).toEqual([])
    expect(result.failure).toContain("Claude Code non è installato")
  })

  test("l'errore del provider resta, per capire il «riprova» che si ripete", async () => {
    const result = await planUtterance("qualsiasi cosa", context, async () => {
      throw new Error("401 Unauthorized: Bearer sk-or-v1-abcdefghijklmnopqrstuvwxyz012345 refused")
    })

    // What the user is told, and what explains it, are two different things.
    expect(result.failure).toContain("chiave del servizio")
    expect(result.failure).not.toContain("sk-or-v1")
    // The detail is what the provider said, untouched: whoever shows it takes
    // the keys out, and that is not this module's job to guess.
    expect(result.detail).toContain("401 Unauthorized")
    expect(result.detail).toContain("sk-or-v1-abcdefghijklmnopqrstuvwxyz012345")
  })

  test("un annullamento non lascia nessun dettaglio", async () => {
    const abort = new Error("The operation was aborted")
    abort.name = "AbortError"
    const result = await planUtterance("qualsiasi cosa", context, async () => {
      throw abort
    })

    expect(result.failure).toBeUndefined()
    expect(result.detail).toBeUndefined()
  })

  test("una risposta illeggibile viene detta, non ignorata", async () => {
    const result = await planUtterance("qualsiasi cosa", context, async () => "boh")
    expect(result.failure).toBeDefined()
  })

  test("il piano passa comunque dalla validazione: agente inventato, zero passi", async () => {
    const result = await planUtterance("avvia copilot", context, async () =>
      JSON.stringify([{ action: "start_session", agent: "copilot" }]),
    )

    expect(result.steps).toEqual([])
    expect(result.refusals[0]).toContain("copilot")
  })

  test("supporta una risposta puramente conversazionale di Jarvis con speech", async () => {
    const result = await planUtterance("chi sei e cosa puoi fare per me?", context, async () =>
      JSON.stringify({
        speech: "Sono Jarvis, il tuo assistente vocale in ADE. Posso avviare sessioni e guidarti nel codice.",
        steps: [],
      }),
    )

    expect(result.failure).toBeUndefined()
    expect(result.steps).toEqual([])
    expect(result.refusals).toEqual([])
    expect(result.speech).toBe(
      "Sono Jarvis, il tuo assistente vocale in ADE. Posso avviare sessioni e guidarti nel codice.",
    )
  })

  test("supporta risposta combinata con speech e steps", async () => {
    const result = await planUtterance("avvia claude sul parser", context, async () =>
      JSON.stringify({
        speech: "Subito Nik, avvio la sessione Claude Code per analizzare il parser.",
        steps: [{ action: "start_session", agent: "claude", task: "analizza il parser" }],
      }),
    )

    expect(result.failure).toBeUndefined()
    expect(result.steps).toHaveLength(1)
    expect(result.speech).toBe("Subito Nik, avvio la sessione Claude Code per analizzare il parser.")
  })

  test("buildPlannerPrompt include la cronologia dei turni precedenti quando fornita", () => {
    const multiTurnContext: PlanContext = {
      ...context,
      recentHistory: [
        { role: "user", text: "avvia claude sul parser" },
        { role: "assistant", text: "Sessione Claude avviata." },
      ],
    }
    const { user } = buildPlannerPrompt("ora chiedigli di eseguire i test", multiTurnContext)
    expect(user).toContain("Cronologia recente della conversazione")
    expect(user).toContain("avvia claude sul parser")
    expect(user).toContain("Sessione Claude avviata.")
  })
})

describe("planUtterance streams the speech", () => {
  test("dice le prime parole mentre il resto della risposta sta ancora arrivando", async () => {
    const heard: string[] = []
    const result = await planUtterance(
      "apri il progetto ade",
      context,
      async ({ onText }) => {
        onText?.('{"speech":"Apro')
        onText?.('{"speech":"Apro il progetto ade.","steps":[')
        onText?.('{"speech":"Apro il progetto ade.","steps":[{"action":"open_project","project":"nikcli"}]}')
        return '{"speech":"Apro il progetto ade.","steps":[{"action":"open_project","project":"nikcli"}]}'
      },
      { onSpeech: (soFar) => void heard.push(soFar) },
    )
    // Una volta per ogni volta che speech è cresciuto, mai due volte lo stesso testo.
    expect(heard).toEqual(["Apro", "Apro il progetto ade."])
    expect(result.steps).toHaveLength(1)
  })

  test("senza onSpeech il completamento non riceve nessun onText", async () => {
    let received: unknown = "unset"
    await planUtterance("x", context, async (prompt) => {
      received = prompt.onText
      return "[]"
    })
    expect(received).toBeUndefined()
  })

  test("la frase non passa da nessuna rete: il completamento è tutto quello che il pianificatore chiama", async () => {
    const original = globalThis.fetch
    let fetched = 0
    globalThis.fetch = (async () => {
      fetched++
      return new Response("{}")
    }) as unknown as typeof fetch
    try {
      await planUtterance("apri il progetto ade", context, async () => "[]")
    } finally {
      globalThis.fetch = original
    }
    expect(fetched).toBe(0)
  })
})

describe("plannerFailure", () => {
  /*
   * Il messaggio del provider finiva a voce. «Il servizio ha risposto 429» non
   * dice niente a chi sta al microfono, e un fetch fallito arriva come
   * `TypeError: fetch failed`.
   */
  test("un codice del servizio diventa una frase che dice cosa fare", () => {
    const said = plannerFailure(new Error("Il servizio ha risposto 429."))
    expect(said).toContain("troppe richieste")
    expect(said).toMatch(/riprova/i)
    expect(said).not.toContain("429")
  })

  test("una chiave rifiutata dice dove correggarla, senza nome del servizio né chiave", () => {
    const said = plannerFailure(new Error("401 Unauthorized"))
    expect(said).toContain("chiave")
    expect(said).toContain("impostazioni")
    expect(said).not.toMatch(/openrouter|bearer|sk-/i)
  })

  test("la frase del pianificatore sul runner arriva com'è: dice cosa non va, non «fra un momento»", () => {
    const said = plannerFailure(new Error("Non riesco a pianificare: Claude Code non si avvia."))
    expect(said).toBe("Non riesco a pianificare: Claude Code non si avvia.")
  })

  test("un errore del servizio e una rete che non c'è si distinguono", () => {
    expect(plannerFailure(new Error("Il servizio ha risposto 503."))).toContain("errore")
    const rete = plannerFailure(new TypeError("fetch failed"))
    expect(rete).toContain("connessione")
    expect(rete).not.toContain("fetch")
  })

  test("un timeout è un timeout, non una cancellazione", () => {
    const timeout = Object.assign(new Error("The operation was aborted"), { name: "TimeoutError" })
    expect(plannerFailure(timeout)).toContain("in tempo")
  })

  test("l'annullamento dell'utente non dice niente", () => {
    const abort = Object.assign(new Error("This operation was aborted"), { name: "AbortError" })
    expect(plannerFailure(abort)).toBeUndefined()
  })

  test("il messaggio già scritto per l'utente passa com'è", () => {
    const scritto = "Non riesco a pianificare: Claude Code non è installato."
    expect(plannerFailure(new Error(scritto))).toBe(scritto)
  })

  test("un errore che non si sa classificare resta in italiano e non grezzo", () => {
    const said = plannerFailure("ECONNRESET while reading from socket")
    expect(said).toBeTypeOf("string")
    expect(said).not.toContain("ECONNRESET")
  })

  test("il piano annullato non porta alcun messaggio da dire", async () => {
    const abort = Object.assign(new Error("This operation was aborted"), { name: "AbortError" })
    const result = await planUtterance("avvia due sessioni", context, () => Promise.reject(abort))
    expect(result.failure).toBeUndefined()
    expect(result.steps).toEqual([])
  })

  test("un 429 dal provider non viene detto con il suo codice", async () => {
    const result = await planUtterance("avvia due sessioni", context, () =>
      Promise.reject(new Error("Il servizio ha risposto 429.")),
    )
    expect(result.failure).toBeDefined()
    expect(result.failure).not.toContain("429")
  })
})
