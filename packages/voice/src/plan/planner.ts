/**
 * Turning a sentence the grammar could not match into a plan.
 *
 * The hand-written vocabulary (`intent/parse.ts`) handles what people say
 * often, instantly and offline. It cannot handle "avvia quattro sessioni
 * claude nel progetto nikcli, una sul parser e una sui test", and no list of
 * phrases ever will: the count, the agent, the project and one free-text task
 * per session are four open dimensions at once.
 *
 * So this is the second half of a hybrid. It runs only on the utterances the
 * grammar rejected, which keeps the common case free of a network round trip,
 * and everything it produces goes through `validatePlan` before it can touch
 * the host — the model proposes, it does not decide.
 */

import { MAX_PLAN_STEPS, validatePlan, type PlanContext, type ValidatedPlan } from "./schema"

/**
 * The one call this module needs, injected so tests never touch a model.
 *
 * `system` is the same for every sentence, so a process kept running can hold it once; everything that
 * changes (the panes, the projects, the last turns) is in `user`. `onText` gets the answer as it is
 * written, raw, so the first words of `speech` can be said before the JSON is complete.
 */
export type Completion = (prompt: {
  system: string
  user: string
  signal?: AbortSignal
  onText?: (soFar: string) => void
}) => Promise<string>

export interface PlannerResult extends ValidatedPlan {
  /**
   * Why nothing could be planned, when that is the outcome — a missing key, a
   * refused request, an unreachable network. Separate from `refusals`, which
   * is about steps that were understood and rejected; this is about not
   * having got an answer at all, and the user is told different things.
   */
  failure?: string
  /**
   * The provider's own words for the failure, when it had any.
   *
   * Not for the user: `failure` is what they hear, and this is the thing that
   * explains it — a "riprova fra un momento" that keeps coming back is a rate
   * limit, a wrong key or a network, and the sentence alone says which of the
   * three to go and look at. It can quote the key that was refused, so whoever
   * shows it takes the keys out first: this is never said, never written to a
   * log, and never stored.
   */
  detail?: string
}

/** What the provider said, as an error's name and message, however it arrived. */
function providerError(error: unknown): { name: string; message: string } {
  return {
    name: error instanceof Error ? error.name : "",
    message: error instanceof Error ? error.message : String(error ?? ""),
  }
}

/** What a pane's state means to someone asking «chi è bloccato?». */
const PANE_STATE_IT: Record<string, string> = {
  idle: "ferma",
  provisioning: "in avvio",
  working: "al lavoro",
  waiting: "in attesa di una risposta dell'utente",
  done: "ha finito",
  error: "in errore",
}

/**
 * The rules, once: they do not change from one sentence to the next, so a process kept running can hold
 * them in its system prompt and be sent only the part that changes (`plannerContext`).
 */
export const PLANNER_SYSTEM = [
  "Sei JARVIS, l'assistente vocale intelligente e compagno di pair programming dentro NIK ADE.",
  "Comprendi la voce dell'utente in italiano e rispondi con un oggetto JSON nella forma:",
  '{"speech":"<tua risposta parlata in italiano>","steps":[<eventuali operazioni su ADE>]}',
  "Nessun testo attorno, nessun commento oltre al JSON. Scrivi `speech` per primo: viene letto ad alta voce mentre lo scrivi.",
  "Non usare strumenti, non leggere file e non eseguire comandi: rispondi solo dai dati che ti arrivano con ogni frase.",
  "",
  "Regole per 'speech':",
  "- Rispondi in italiano naturale, tecnico, conciso e professionale (tono Jarvis).",
  "- Massimo 1-3 frasi chiare ad alta densità: l'utente ascolta la sintesi vocale e non vuole monologhi.",
  "- Non tradurre termini tecnici standard come commit, branch, build, test, pane, terminal, debug, pull request.",
  "- Se l'utente chiede lo stato delle sessioni (chi è bloccato, chi ha finito, cosa fa un pannello), rispondi in `speech` con `steps: []`, dai pannelli elencati: nome e stato.",
  "- Se l'utente chiede operazioni su ADE, conferma brevemente in `speech` (es. 'Avvio subito Claude sul progetto nikcli.') e compila `steps`.",
  '- Se la richiesta non è una di queste operazioni e non puoi rispondere con i dati che hai (spiegazioni sul codice, git, il web, chiedere a una sessione e aspettare la risposta), rispondi con una frase brevissima su cosa sta per succedere e passa la mano: {"speech":"Ci penso.","steps":[],"agent":true}. La frase viene detta subito, mentre un agente che può farlo lavora; non promettere un risultato.',
  "",
  "Operazioni ammesse in 'steps' (lascia [] se la richiesta è puramente informativa o discorsiva):",
  '{"action":"start_session","agent":"<id>","task":"<cosa deve fare>","project":"<nome>"}',
  '{"action":"open_project","project":"<nome>"}',
  '{"action":"run_command","command":"<id>"}',
  '{"action":"focus_pane","paneIndex":<n>}',
  '{"action":"send_prompt","paneIndex":<n>,"text":"<messaggio>"}',
  "",
  "Regole operative:",
  `- Al massimo ${MAX_PLAN_STEPS} operazioni in steps.`,
  "- Più sessioni diverse sono più operazioni start_session distinte.",
  "- `task` è il compito in italiano. Se non indicato, ometti il campo.",
  "- Usa solo gli id elencati nei dati. Non inventare agenti, progetti o comandi.",
  "- Un pannello si indica con il suo numero (paneIndex) preso dall'elenco «Pannelli»: «apri la sessione di Dario» è focus_pane sul pannello che si chiama Dario, «manda a Mimo: fai i test» è send_prompt su quello di Mimo. Se nessun pannello ha quel nome, dillo in `speech` e non inventare un numero.",
  "- Non esistono operazioni per chiudere pannelli o terminare processi: rimangono al controllo manuale o alla grammatica fissa.",
].join("\n")

/**
 * What changes with every sentence: which agents, projects and panes there are, the last turns, and the
 * sentence. Real agent ids and project names, because without them the model invents plausible ones and
 * `validatePlan` refuses a plan that was only ever wrong because nobody said what existed.
 */
export function plannerContext(utterance: string, context: PlanContext): string {
  const agents = context.agents
    .map((agent) => `- ${agent.id} (${agent.label})${agent.available ? "" : " — NON installato"}`)
    .join("\n")
  const projects = context.projects
    .map((project) => `- ${project.name}${project.isOpen ? " (aperto ora)" : ""}`)
    .join("\n")
  const panes = (context.panes ?? [])
    .map(
      (pane) =>
        `${pane.index} · ${pane.title}${pane.agent ? ` · ${pane.agent}` : ""} · ${PANE_STATE_IT[pane.status] ?? pane.status}`,
    )
    .join("\n")

  const historyLines =
    context.recentHistory && context.recentHistory.length > 0
      ? [
          "",
          "Cronologia recente della conversazione:",
          ...context.recentHistory.map((h) => `- ${h.role === "user" ? "Utente" : "Jarvis"}: ${h.text}`),
        ]
      : []

  return [
    "Agenti disponibili:",
    agents || "- (nessuno)",
    "",
    "Progetti:",
    projects || "- (nessuno)",
    "",
    "Pannelli (numero · titolo · agente · stato):",
    panes || "- (nessuno)",
    `Pannelli aperti: ${context.paneCount}${context.focusedPaneTitle ? ` (a fuoco: "${context.focusedPaneTitle}")` : ""}`,
    context.activeProjectName ? `Progetto attivo: ${context.activeProjectName}` : "",
    "",
    "Comandi:",
    context.commands.length ? context.commands.map((id) => `- ${id}`).join("\n") : "- (nessuno)",
    ...historyLines,
    "",
    `Frase dell'utente: ${utterance}`,
  ]
    .filter((line, at, all) => line !== "" || all[at - 1] !== "")
    .join("\n")
}

/** The two halves of a request: the rules that stay, and what changed. */
export function buildPlannerPrompt(
  utterance: string,
  context: PlanContext,
): {
  system: string
  user: string
} {
  return { system: PLANNER_SYSTEM, user: plannerContext(utterance, context) }
}

/**
 * The `speech` written so far, from an answer that is still arriving: the text between the quotes,
 * escapes undone, up to the closing quote or as far as the answer has got. Empty until `speech` starts.
 */
export function speechSoFar(raw: string): string {
  const key = /"speech"\s*:\s*"/.exec(raw)
  if (!key) return ""
  let out = ""
  for (let i = key.index + key[0].length; i < raw.length; i++) {
    const c = raw[i]
    if (c === '"') return out
    if (c !== "\\") {
      out += c
      continue
    }
    const next = raw[i + 1]
    if (next === undefined) break
    if (next === "u") {
      const hex = raw.slice(i + 2, i + 6)
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) break
      out += String.fromCharCode(parseInt(hex, 16))
      i += 5
      continue
    }
    out += next === "n" ? "\n" : next === "t" ? "\t" : next
    i++
  }
  return out
}

/**
 * Pulls the JSON out of a model's answer.
 *
 * Handles both JSON arrays `[...]` and JSON objects `{...}`, with or without
 * markdown code fences or conversational prefaces.
 */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const body = (fenced ? fenced[1] : text).trim()

  const direct = tryParse(body)
  if (direct !== undefined) return direct

  // Check whichever outermost delimiter appears first in the string
  const arrStart = body.indexOf("[")
  const objStart = body.indexOf("{")

  if (arrStart !== -1 && (objStart === -1 || arrStart < objStart)) {
    const arrEnd = body.lastIndexOf("]")
    if (arrEnd > arrStart) {
      const span = tryParse(body.slice(arrStart, arrEnd + 1))
      if (span !== undefined) return span
    }
  }

  if (objStart !== -1) {
    const objEnd = body.lastIndexOf("}")
    if (objEnd > objStart) {
      const span = tryParse(body.slice(objStart, objEnd + 1))
      if (span !== undefined) return span
    }
  }

  // Fallback: check array if object check was skipped or failed
  if (arrStart !== -1) {
    const arrEnd = body.lastIndexOf("]")
    if (arrEnd > arrStart) {
      const span = tryParse(body.slice(arrStart, arrEnd + 1))
      if (span !== undefined) return span
    }
  }

  return undefined
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/**
 * What to say when the planner's own call could not be made.
 *
 * The provider's message is not what the user hears. It arrives in English or
 * as a code nobody can act on - "il servizio ha risposto 429" tells a person
 * standing at the microphone nothing - and a fetch failure arrives as
 * `TypeError: fetch failed`. What is said instead is a sentence in Italian
 * that names the situation and, where there is one, what to do about it.
 *
 * A missing key keeps the message this module writes itself: it is already a
 * sentence for the user and it points at the settings.
 *
 * `undefined` means there is nothing to say: the user pressed «annulla», so
 * the one thing wrong is that something is being said at all.
 */
export function plannerFailure(error: unknown): string | undefined {
  const { name, message: raw } = providerError(error)
  // Case and punctuation vary between runtimes, and the message is the only
  // thing a fetch failure has.
  const text = raw.toLowerCase()

  // Our own sentences, already written for the user: the runner's ("Non riesco a pianificare: Claude Code non si avvia").
  if (raw.startsWith("Non riesco a pianificare")) return raw

  // A timeout is read before a cancellation, because a timed-out fetch is
  // aborted too and says so: only the name tells the two apart. Neither is a
  // user cancellation, and a user cancellation is not a failure to report.
  if (name === "TimeoutError" || (!name.includes("Abort") && /\btimed? ?out\b|timeout/.test(text))) {
    return "Non ho raggiunto il servizio in tempo. Riprova fra un momento."
  }
  if (name === "AbortError" || text.includes("operation was aborted")) return undefined

  if (/\b429\b|rate limit|too many requests/.test(text)) {
    return "Il servizio ha ricevuto troppe richieste in poco tempo. Riprova fra un momento."
  }
  if (/\b40[13]\b|unauthorized|forbidden|api[- ]?key|invalid.*key/.test(text)) {
    return "La chiave del servizio non è valida. Puoi correggerla nelle impostazioni della voce."
  }
  if (/\b5\d\d\b|internal server error|bad gateway|service unavailable|overloaded/.test(text)) {
    return "Il servizio ha risposto con un errore. Riprova fra un momento."
  }
  if (/fetch failed|network|econnrefused|econnreset|enotfound|eai_again|socket|dns|certificate|unable to/.test(text)) {
    return "Non ho raggiunto il servizio. Controlla la connessione e riprova."
  }
  return "Non sono riuscito a ottenere un piano. Riprova fra un momento."
}

/**
 * Plans one utterance. Never throws: every failure becomes something to say.
 */
export async function planUtterance(
  utterance: string,
  context: PlanContext,
  complete: Completion,
  options: {
    signal?: AbortSignal
    /** The `speech` so far, each time it grows: said while the rest of the answer is still being written. */
    onSpeech?: (soFar: string) => void
  } = {},
): Promise<PlannerResult> {
  const prompt = buildPlannerPrompt(utterance, context)

  let answer: string
  let said = ""
  try {
    answer = await complete({
      ...prompt,
      signal: options.signal,
      ...(options.onSpeech
        ? {
            onText: (raw: string) => {
              const speech = speechSoFar(raw)
              if (speech === said) return
              said = speech
              options.onSpeech?.(speech)
            },
          }
        : {}),
    })
  } catch (error) {
    const failure = plannerFailure(error)
    // What the user is told, and what explains it, are two different things:
    // the first is a sentence in Italian, the second is what the provider
    // said. Both, because the second used to be thrown away with the error.
    const detail = providerError(error).message
    return failure ? { steps: [], refusals: [], failure, ...(detail ? { detail } : {}) } : { steps: [], refusals: [] }
  }

  const raw = extractJson(answer)
  if (raw === undefined) {
    return { steps: [], refusals: [], failure: "Non ho capito cosa fare con quella frase." }
  }

  /*
   * An empty array is the model saying "questa frase non chiede niente" —
   * which the system prompt asks for explicitly. It is a valid answer, not a
   * failure, and treating it as one would turn every stray word picked up by
   * the microphone into an error message.
   */
  return validatePlan(raw, context)
}
