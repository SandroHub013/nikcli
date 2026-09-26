import { describe, expect, test } from "bun:test"
import { buildPlannerPrompt, createOpenRouterCompletion, extractJson, plannerFailure, planUtterance } from "./planner"
import type { PlanContext } from "./schema"

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
    const { system } = buildPlannerPrompt("avvia due sessioni", context)

    expect(system).toContain("claude-code")
    expect(system).toContain("nikcli")
    expect(system).toContain("palette.open")
    // E cosa NON esiste, altrimenti lo propone e basta.
    expect(system).toContain("NON installato")
  })

  test("la frase dell'utente non viene riscritta", () => {
    const { user } = buildPlannerPrompt("avvia 4 sessioni claude", context)
    expect(user).toBe("avvia 4 sessioni claude")
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
      throw new Error("Manca la chiave OpenRouter")
    })

    expect(result.steps).toEqual([])
    expect(result.failure).toContain("chiave OpenRouter")
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
    const { system } = buildPlannerPrompt("ora chiedigli di eseguire i test", multiTurnContext)
    expect(system).toContain("Cronologia recente della conversazione")
    expect(system).toContain("avvia claude sul parser")
    expect(system).toContain("Sessione Claude avviata.")
  })
})

describe("createOpenRouterCompletion", () => {
  test("returns usage cost and asks OpenRouter to include it", async () => {
    const authorizations: string[] = []
    let sent: Record<string, unknown> | undefined
    const fetchFn = (async (_input: URL | RequestInfo, init?: RequestInit) => {
      authorizations.push(new Headers(init?.headers).get("Authorization") ?? "")
      sent = JSON.parse(String(init?.body)) as Record<string, unknown>
      return new Response(JSON.stringify({
        choices: [{ message: { content: "[]" } }],
        usage: { cost: 0.002 },
      }), { status: 200 })
    }) as unknown as typeof fetch
    let usage: { cost?: number } | undefined
    const complete = createOpenRouterCompletion({
      apiKey: "key",
      fetchFn,
      onUsage: (value) => void (usage = value),
    })

    expect(await complete({ system: "system", user: "utterance" })).toBe("[]")
    expect(authorizations).toEqual(["Bearer key"])
    expect(sent?.usage).toEqual({ include: true })
    expect(usage).toEqual({ cost: 0.002 })
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

  test("i due messaggi già scritti per l'utente passano come sono", () => {
    const chiave = "Manca la chiave OpenRouter: aggiungila nelle impostazioni della voce."
    expect(plannerFailure(new Error(chiave))).toBe(chiave)
    const formato = "Risposta del servizio in un formato inatteso."
    expect(plannerFailure(new Error(formato))).toBe(formato)
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