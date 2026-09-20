/**
 * The voice assistant's agent: what answers a sentence the grammar does not know.
 *
 * It is a coding agent's CLI running one turn per sentence (`bots/turn.ts`),
 * signed in with the user's own account — Claude Code with an Anthropic
 * subscription, Codex with ChatGPT, nikcli with its providers — so a spoken
 * request costs the subscription the user already has, not a key billed per
 * call. The turn gets an `ade-msg` identity, which is what lets it list, ask,
 * start and close ADE's sessions: the same hook every session in a pane has.
 *
 * The decisions — which CLI, what to tell it, when a conversation continues —
 * are pure and tested here; `createVoiceAgent` only holds the conversation and
 * calls the runner.
 */

import type { AgentStatus } from "../session-new/availability"
import { limitReached } from "../bots/terms"
import { answerSoFar, type RunnerId } from "../bots/runners"
import type { Talk } from "../bots/talk"
import type { TurnRequest, TurnResult } from "../bots/turn"
import { locale as currentAppLocale, t } from "../i18n"

export type VoiceAgentEngine = "auto" | "claude" | "codex" | "nikcli"

/** Runner id to the catalogue id whose PATH probe says whether it is installed. */
const CATALOGUE_ID: Record<RunnerId, string> = {
  claude: "claude-code",
  codex: "codex",
  nikcli: "nikcli",
}

/**
 * `auto` tries these in order: the subscriptions most users have first.
 *
 * nikcli is not among them. A voice turn must not change the project, and
 * nikcli cannot be told so for one turn (`enforcesDisabledTools`): it would
 * only have the instructions asking it not to.
 */
const AUTO_ORDER: readonly RunnerId[] = ["claude", "codex"]

/**
 * How long a spoken request may take before the turn is stopped.
 *
 * Above the 110 s an `ade-msg ask` waits for its session, so a blocking ask
 * can still come back with an answer; far below the five minutes a turn gets
 * elsewhere, because nobody waits that long for a spoken reply.
 */
export const VOICE_AGENT_TIMEOUT_MS = 150_000

/**
 * The fast setting, per runner: what a spoken answer needs is a short reply
 * soon, and the CLI's default model thinks longer than that.
 */
export const VOICE_AGENT_FAST: Record<RunnerId, { readonly model?: string; readonly effort?: string }> = {
  claude: { model: "claude-sonnet-5", effort: "low" },
  codex: { effort: "low" },
  nikcli: {},
}

/** What a voice turn may not do: edit, write, or run a command other than `ade-msg`. */
export const VOICE_AGENT_DISABLED_TOOLS: readonly string[] = ["edit", "write", "bash"]

/**
 * The runner a request goes to, or why there is none.
 *
 * A named engine is used as asked, installed or not: the turn's own failure
 * ("claude non si avvia") says more than a guess here would. `auto` takes the
 * first one the probe found, and while the probe has not answered it takes the
 * first in order, for the same reason the voice host reports unknown agents as
 * available.
 */
export function resolveVoiceAgentRunner(
  engine: VoiceAgentEngine,
  statuses: readonly AgentStatus[] | undefined,
  lang: "it" | "en" = "it",
): { runner: RunnerId } | { problem: string } {
  if (engine === "nikcli") {
    return {
      problem:
        lang === "en"
          ? "nikcli cannot answer voice in read-only mode: choose Claude Code or Codex."
          : "nikcli non può rispondere alla voce in sola lettura: scegli Claude Code o Codex.",
    }
  }
  if (engine !== "auto") return { runner: engine }
  if (!statuses) return { runner: AUTO_ORDER[0] }
  const found = AUTO_ORDER.find(
    (id) => statuses.find((status) => status.agent.id === CATALOGUE_ID[id])?.availability !== "assente",
  )
  return found
    ? { runner: found }
    : {
        problem:
          lang === "en"
            ? "To answer I need Claude Code or Codex, and neither is installed."
            : "Per rispondere mi serve Claude Code o Codex, e non ne trovo nessuno installato.",
      }
}

/**
 * Who the agent is, said once per turn as its system prompt.
 *
 * Every line is here because a turn without it went wrong in a specific way:
 * answers are read aloud, so markdown and lists become noise; the turn has no
 * terminal, so an `ade-msg ask` left with `--no-wait` delivers its answer to
 * nobody; and it runs in the user's project, so an agent that edited files
 * itself would be doing, unseen, the work the sessions exist to do in view.
 */
export const VOICE_AGENT_INSTRUCTIONS_IT = [
  "Sei nik, l'assistente vocale di ADE, un ambiente in cui più sessioni di agenti di programmazione lavorano in pannelli affiancati.",
  "Parli con l'utente come un collega: gli dai del tu e parli in prima persona («Chiedo a Prova-voce.», «Ho aperto la sessione.»).",
  "Quello che scrivi viene letto ad alta voce mentre lo scrivi: rispondi in italiano, in una o due frasi brevi, senza markdown, elenchi, codice o percorsi lunghi.",
  "Se ti serve tempo, per esempio per chiedere a una sessione o cercare sul web, scrivi prima una frase brevissima su cosa stai facendo, chiusa da un punto; poi il risultato.",
  "Quando riferisci il lavoro di un'altra sessione, di' il suo nome e il risultato. Chiudi con una domanda solo quando ti serve una decisione.",
  "Se qualcosa non riesce, dillo in parole semplici, senza codici di errore, e di' cosa può fare l'utente.",
  "Per gestire le sessioni usa il comando ade-msg dalla shell:",
  "- ade-msg list: le sessioni aperte;",
  "- ade-msg ask SESSIONE \"RICHIESTA\": chiede e aspetta la risposta; usalo sempre così, bloccante, perché non hai un terminale che riceva risposte dopo;",
  "- ade-msg spawn AGENTE \"COMPITO\" --no-wait: avvia una sessione per un lavoro lungo; poi di' all'utente che è partita, senza aspettarla;",
  "- ade-msg send SESSIONE \"TESTO\": una nota; ade-msg close SESSIONE: chiude una sessione avviata da te.",
  "Non modificare file e non eseguire comandi che cambiano il progetto: il lavoro lo fanno le sessioni, dove l'utente lo vede.",
  "Non puoi aprire pannelli e non scrivere mai righe che iniziano con @ade: qui verrebbero lette ad alta voce. Se l'utente vuole un pannello, digli di dire «apri il browser», «apri il video», «apri il modello 3D», «apri il simulatore» o «apri le decisioni».",
  "Se la richiesta è ambigua, o chiudere o fermare qualcosa farebbe perdere lavoro, chiedi conferma invece di agire.",
].join("\n")

export const VOICE_AGENT_INSTRUCTIONS_EN = [
  "You are nik, the voice assistant for ADE, an environment where multiple programming agent sessions work side by side in panels.",
  "Talk to the user like a colleague: speak in the first person («Asking Test-Voice.», «I opened the session.»).",
  "What you write is read out loud as you write it: respond in English, in one or two short sentences, without markdown, lists, code, or long paths.",
  "If you need time, for example to ask a session or search the web, write a very short sentence first about what you are doing, ending with a period; then the result.",
  "When reporting work from another session, state its name and result. End with a question only when a decision is needed.",
  "If something fails, say so in simple words without error codes, and say what the user can do.",
  "To manage sessions use the ade-msg command from the shell:",
  "- ade-msg list: list open sessions;",
  "- ade-msg ask SESSION \"REQUEST\": asks and waits for the reply; always use it blocking like this, because you don't have a terminal to receive later replies;",
  "- ade-msg spawn AGENT \"TASK\" --no-wait: launches a session for long work; then tell the user it started, without waiting for it;",
  "- ade-msg send SESSION \"TEXT\": a note; ade-msg close SESSION: closes a session you started.",
  "Do not modify files and do not run commands that change the project: sessions do the work where the user can see it.",
  "You cannot open panels and never write lines starting with @ade: here they would be read out loud. If the user wants a panel, tell them to say «open browser», «open video», «open 3D model», «open simulator», or «open decisions».",
  "If the request is ambiguous, or closing/stopping something would lose work, ask for confirmation instead of acting.",
].join("\n")

export const VOICE_AGENT_INSTRUCTIONS = VOICE_AGENT_INSTRUCTIONS_IT

/** What `ask` needs from the app: a runner to call, and what is installed. */
export interface VoiceAgentDeps {
  runTurn: (request: TurnRequest) => { result: Promise<TurnResult>; stop: () => void }
  /**
   * Claude Code kept running between sentences (`bots/warm.ts`). When given,
   * every Claude turn goes there, and the conversation lives in the process.
   */
  warm?: {
    prepare: (request: TurnRequest) => void
    run: (request: TurnRequest) => { result: Promise<TurnResult>; stop: () => void }
    forget: () => void
    close: () => void
  }
  statuses: () => readonly AgentStatus[] | undefined
  cwd: () => string | undefined
  locale?: () => "it" | "en"
}

export interface VoiceAgent {
  /** `ran` is false only when no turn started: see `VoiceHost.askAgent`. */
  ask(request: {
    text: string
    engine: VoiceAgentEngine
    /** `fast` uses `VOICE_AGENT_FAST`; absent or `cli` leaves the CLI's own model. */
    speed?: "fast" | "cli"
    signal?: AbortSignal
    /** The answer so far, each time it grows, so it can be read before it is finished. */
    onText?: (soFar: string) => void
  }): Promise<{ ok: boolean; text: string; ran: boolean }>
  /** Starts the next sentence in a new conversation. */
  forget(): void
  /** Gets the agent ready for a sentence that may come soon. */
  prepare(request: { engine: VoiceAgentEngine; speed?: "fast" | "cli" }): void
  /** Lets go of what `prepare` started: the voice is off. */
  release(): void
}

/**
 * Calls `onText` only when the answer so far has changed. A message that is
 * complete ends with a blank line, so its last sentence is read at once
 * rather than when the turn ends, stop or no stop.
 */
function textFollower(onText: (soFar: string) => void): (talk: Talk) => void {
  let last = ""
  return (talk) => {
    const written = answerSoFar(talk)
    const soFar = written && talk.streaming === undefined ? `${written}\n\n` : written
    if (!soFar || soFar === last) return
    last = soFar
    onText(soFar)
  }
}

/** Whether a turn's outcome indicates Claude reached the plan's usage/quota limit. */
function isLimitTurn(result: TurnResult): boolean {
  const check = (s?: string) => {
    if (!s) return false
    return (
      limitReached(s) ||
      s.includes("raggiunto il limite") ||
      s.includes("al limite del") ||
      s.includes("limite del tuo piano")
    )
  }
  if (check(result.problem) || check(result.text)) return true
  return result.talk?.messages?.some((m) => check(m.text)) ?? false
}

/** Whether Codex is installed and available to be run as fallback. */
function isCodexAvailable(statuses: readonly AgentStatus[] | undefined): boolean {
  if (!statuses) return true
  const st = statuses.find((s) => s.agent.id === CATALOGUE_ID.codex)
  return st !== undefined && st.availability !== "assente"
}

export function createVoiceAgent(deps: VoiceAgentDeps): VoiceAgent {
  const currentLocale = (): "it" | "en" => (deps.locale ? deps.locale() : currentAppLocale())

  /*
   * One conversation per runner and project. A follow-up ("e la seconda?")
   * only makes sense to the agent that heard the first question, so the
   * session id is carried over; switching engine or project starts afresh,
   * because the id means nothing to another CLI and the old context would
   * describe the wrong sessions.
   */
  let conversation: { runner: RunnerId; cwd: string | undefined; sessionId: string } | undefined
  /*
   * A new sentence stops the turn still running, and that turn can end after
   * the new one started: only the newest turn may say which conversation
   * comes next.
   */
  let latest = 0

  /* Everything but the sentence: the same for a turn and for the process that waits for one. */
  const turnFor = (runner: RunnerId, cwd: string | undefined, speed: "fast" | "cli" | undefined): Omit<TurnRequest, "message"> => {
    const loc = currentLocale()
    return {
      runner,
      instructions: loc === "en" ? VOICE_AGENT_INSTRUCTIONS_EN : VOICE_AGENT_INSTRUCTIONS_IT,
      ...(cwd ? { cwd } : {}),
      disabledTools: VOICE_AGENT_DISABLED_TOOLS,
      mailbox: { id: "voce" },
      // No MCP servers or user settings: a spoken answer is worth more than
      // the user's connectors, and loading them tripled the wait.
      lean: true,
      timeoutMs: VOICE_AGENT_TIMEOUT_MS,
      // Always asked for: the warm process is started before anyone listens to it.
      partial: runner === "claude",
      ...(speed === "fast" ? VOICE_AGENT_FAST[runner] : {}),
    }
  }

  return {
    prepare({ engine, speed }) {
      if (!deps.warm) return
      const resolved = resolveVoiceAgentRunner(engine, deps.statuses(), currentLocale())
      if ("problem" in resolved || resolved.runner !== "claude") return
      deps.warm.prepare({ ...turnFor("claude", deps.cwd(), speed), message: "" })
    },

    async ask({ text, engine, speed, signal, onText }) {
      const loc = currentLocale()
      const resolved = resolveVoiceAgentRunner(engine, deps.statuses(), loc)
      if ("problem" in resolved) return { ok: false, text: resolved.problem, ran: false }

      const generation = ++latest
      const cwd = deps.cwd()
      const warm = resolved.runner === "claude" ? deps.warm : undefined
      const previous =
        !warm && conversation && conversation.runner === resolved.runner && conversation.cwd === cwd
          ? conversation.sessionId
          : undefined

      const request: TurnRequest = {
        ...turnFor(resolved.runner, cwd, speed),
        message: text,
        ...(previous ? { sessionId: previous } : {}),
        ...(onText ? { onUpdate: textFollower(onText) } : {}),
      }
      const turn = warm ? warm.run(request) : deps.runTurn(request)
      const onAbort = () => turn.stop()
      signal?.addEventListener("abort", onAbort, { once: true })
      try {
        const result = await turn.result
        if (
          engine === "auto" &&
          resolved.runner === "claude" &&
          !signal?.aborted &&
          result.status !== "stopped" &&
          isLimitTurn(result)
        ) {
          signal?.removeEventListener("abort", onAbort)
          const statuses = deps.statuses()
          if (!isCodexAvailable(statuses)) {
            return {
              ok: false,
              text: t("voice.fallback.codexUnavailable"),
              ran: true,
            }
          }
          const noticePrefix = t("voice.fallback.prefix")
          const codexPrevious =
            conversation && conversation.runner === "codex" && conversation.cwd === cwd
              ? conversation.sessionId
              : undefined
          const codexFollower = onText
            ? textFollower((soFar) => onText(`${noticePrefix} ${soFar}`))
            : undefined
          const codexRequest: TurnRequest = {
            ...turnFor("codex", cwd, speed),
            message: text,
            ...(codexPrevious ? { sessionId: codexPrevious } : {}),
            ...(codexFollower ? { onUpdate: codexFollower } : {}),
          }
          const codexTurn = deps.runTurn(codexRequest)
          const onCodexAbort = () => codexTurn.stop()
          signal?.addEventListener("abort", onCodexAbort, { once: true })
          try {
            const codexResult = await codexTurn.result
            if (codexResult.sessionId && generation === latest) {
              conversation = { runner: "codex", cwd, sessionId: codexResult.sessionId }
            }
            if (codexResult.status === "done") {
              const answerText = codexResult.text
                ? `${noticePrefix} ${codexResult.text}`
                : `${noticePrefix} Fatto.`
              return { ok: true, text: answerText, ran: true }
            }
            if (codexResult.status === "stopped") return { ok: false, text: "", ran: true }
            const failDetail = codexResult.problem || codexResult.text || "nessuna risposta."
            return {
              ok: false,
              text: t("voice.fallback.codexFailed", failDetail),
              ran: true,
            }
          } finally {
            signal?.removeEventListener("abort", onCodexAbort)
          }
        }
        if (result.sessionId && generation === latest) conversation = { runner: resolved.runner, cwd, sessionId: result.sessionId }
        if (result.status === "done") {
          return { ok: true, text: result.text || (loc === "en" ? "Done." : "Fatto."), ran: true }
        }
        if (result.status === "stopped") return { ok: false, text: "", ran: true }
        return {
          ok: false,
          text:
            result.problem ||
            (loc === "en"
              ? "Could not answer you: agent gave no output."
              : "Non sono riuscito a risponderti: l'agente non ha detto niente."),
          ran: true,
        }
      } finally {
        signal?.removeEventListener("abort", onAbort)
      }
    },

    forget() {
      latest++
      conversation = undefined
      deps.warm?.forget()
    },

    release() {
      deps.warm?.close()
    },
  }
}
