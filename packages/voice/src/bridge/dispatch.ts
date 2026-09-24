/**
 * Intent dispatcher translating parsed voice intents into concrete VoiceHost calls.
 *
 * Handles:
 * - 1-based index and fuzzy title resolution for target panes
 * - Safe error handling: non-existent panes or failed host actions return
 *   spoken Italian error messages rather than unhandled rejections
 * - Italian speech readback for all dispatched operations
 */

import { plainProblem } from "../effect/errors"
import { fuzzyMatch } from "@nikcli-ai/ade/command/match"
import type { ParseResult } from "../intent/parse"
import type { AdeView, PaneSummary, VoiceHost } from "./host"

/** The view names `view.set` accepts, in the order the chrome shows them. */
const VIEWS: readonly AdeView[] = ["agent", "code", "chat", "bot"]

export interface DispatchContext {
  /** ID of the currently focused pane in ADE, if any. */
  focusedPaneId?: string
  /** Interface language for spoken readbacks ('it' or 'en'). Defaults to 'it'. */
  lang?: "it" | "en"
}

export interface DispatchOutcome {
  /** True if the operation succeeded on the host. */
  success: boolean
  /** The Italian phrase to read aloud to the user confirming the result. */
  spoken: string
  /** Optional error message if execution failed. */
  error?: string
  /** Optional result data returned by the host. */
  data?: any
}

/**
 * Resolves a target pane from extracted slots using 1-based index or title fuzzy matching.
 */
export function resolveTargetPane(
  slots: Record<string, any>,
  panes: PaneSummary[],
  focusedPaneId?: string,
  /**
   * Vero quando l'azione distrugge qualcosa: chiude un pannello, uccide un
   * processo, nega un permesso. Per queste il pannello va nominato o messo a
   * fuoco — non indovinato. Vedi il commento sul passo 5.
   */
  destructive = false,
  lang: "it" | "en" = "it",
): { pane?: PaneSummary; error?: string } {
  if (panes.length === 0) {
    return { error: lang === "en" ? "No panels currently open in ADE." : "Nessun pannello attualmente aperto su ADE." }
  }

  // 1. By 1-based index
  if (slots.paneIndex !== undefined) {
    const targetIdx = Number(slots.paneIndex)
    const found = panes.find((p) => p.index === targetIdx)
    if (!found) {
      return { error: lang === "en" ? `Panel number ${targetIdx} not found.` : `Pannello numero ${targetIdx} non trovato.` }
    }
    return { pane: found }
  }

  // 2. By pane title using fuzzyMatch
  if (slots.paneTitle) {
    let bestScore = -Infinity
    let bestPane: PaneSummary | undefined

    for (const pane of panes) {
      const hit = fuzzyMatch(
        String(slots.paneTitle).toLowerCase(),
        pane.title.toLowerCase()
      )
      if (hit && hit.score > bestScore) {
        bestScore = hit.score
        bestPane = pane
      }
    }

    if (!bestPane || bestScore <= 0) {
      return {
        error:
          lang === "en"
            ? `No panel matching '${slots.paneTitle}' found.`
            : `Nessun pannello corrispondente a '${slots.paneTitle}' trovato.`,
      }
    }
    return { pane: bestPane }
  }

  // 3. Fallback to paneId slot if provided (e.g. by permission flow)
  if (slots.paneId) {
    const found = panes.find((p) => p.id === slots.paneId)
    if (found) return { pane: found }
  }

  // 4. Fallback to focused pane
  if (focusedPaneId) {
    const focused = panes.find((p) => p.id === focusedPaneId)
    if (focused) return { pane: focused }
  }

  /*
   * 5. Il primo pannello, ma mai per un'azione distruttiva.
   *
   * «Uccidi il processo» detto senza nominare nulla e senza fuoco arrivava
   * qui e prendeva `panes[0]` — che con sei sessioni in griglia è il
   * pannello in alto a sinistra, quasi mai quello a cui si stava pensando.
   * L'agente sbagliato veniva terminato, e il lavoro in corso perso, sulla
   * base di un valore di ripiego.
   *
   * Per le azioni innocue il ripiego resta: «scorri la trascrizione» sul
   * primo pannello, se non ce n'è uno a fuoco, è un fastidio, non un danno.
   */
  if (destructive) {
    return {
      error:
        panes.length === 1
          ? undefined
          : lang === "en"
            ? "Unsure which panel: specify number or name, or focus it."
            : "Non so su quale pannello: dimmi il numero o il nome, oppure mettilo a fuoco.",
      // Con un solo pannello non c'è ambiguità da risolvere.
      pane: panes.length === 1 ? panes[0] : undefined,
    }
  }

  return { pane: panes[0] }
}

/**
 * Dispatches a parsed intent onto the VoiceHost contract.
 */
export async function dispatch(
  result: ParseResult,
  host: VoiceHost,
  ctx: DispatchContext = {}
): Promise<DispatchOutcome> {
  const lang = ctx.lang ?? "it"
  if (result.outcome !== "matched" || !result.intent) {
    return {
      success: false,
      spoken: lang === "en" ? "Could not execute voice command." : "Non è stato possibile eseguire il comando vocale.",
      error: "unmatched_intent",
    }
  }

  const intentId = result.intent.intent
  const slots = result.slots

  /*
   * Preso dal vocabolario, non riscritto qui.
   *
   * `destructive` è già dichiarato accanto a ogni intento, insieme alla
   * domanda di conferma. Duplicare l'elenco in questo file significherebbe
   * che un intento distruttivo aggiunto domani ricadrebbe in silenzio sul
   * ripiego «primo pannello».
   */
  const isDestructive = result.intent.destructive === true

  try {
    switch (intentId) {
      // 1. Commands mapped to host.runCommand
      case "session.new": {
        // It opens the form that starts one; nothing is running yet.
        await host.runCommand("session.new")
        return { success: true, spoken: lang === "en" ? "Opening new session screen." : "Apro la schermata per avviare una nuova sessione." }
      }

      case "video.new":
      case "model.new":
      case "app.new":
      case "decisions.open": {
        await host.runCommand(intentId)
        return { success: true, spoken: `${result.intent.readback}.` }
      }

      case "palette.open": {
        await host.runCommand("palette.open")
        return { success: true, spoken: lang === "en" ? "Command palette opened." : "Tavolozza dei comandi aperta." }
      }

      case "project.open": {
        await host.runCommand("project.open")
        return { success: true, spoken: lang === "en" ? "Opening project selection." : "Apro la selezione del progetto." }
      }

      case "project.recent": {
        // Without a name there is no recent project to open, and no host handles
        // a bare `project.recent`: the project picker is where that choice is made.
        if (!slots.path) {
          await host.runCommand("project.open")
          return { success: true, spoken: lang === "en" ? "Opening project picker." : "Apro la scelta del progetto." }
        }
        await host.runCommand(`project.recent.${slots.path}`)
        return { success: true, spoken: lang === "en" ? "Opening requested recent project." : "Apro il progetto recente richiesto." }
      }

      case "pane.close": {
        const panes = host.listPanes()
        const resolved = resolveTargetPane(slots, panes, ctx.focusedPaneId, isDestructive, lang)
        if (resolved.error) {
          return { success: false, spoken: resolved.error, error: "pane_not_found" }
        }
        host.focusPane(resolved.pane!.id)
        await host.runCommand("pane.close")
        return {
          success: true,
          spoken:
            lang === "en"
              ? `Panel «${resolved.pane!.title}» closed.`
              : `Pannello «${resolved.pane!.title}» chiuso.`,
        }
      }

      case "pane.expand": {
        const panes = host.listPanes()
        const resolved = resolveTargetPane(slots, panes, ctx.focusedPaneId, isDestructive, lang)
        if (resolved.error) {
          return { success: false, spoken: resolved.error, error: "pane_not_found" }
        }
        host.focusPane(resolved.pane!.id)
        await host.runCommand("pane.expand")
        return {
          success: true,
          spoken: lang === "en" ? `Panel ${resolved.pane!.index} size changed.` : `Dimensione del pannello ${resolved.pane!.index} modificata.`,
        }
      }

      case "view.toggle": {
        await host.runCommand("view.toggle")
        return { success: true, spoken: lang === "en" ? "View toggled." : "Vista cambiata." }
      }

      case "theme.toggle": {
        /*
         * «tema chiaro» asks for the light theme, not for the other one: said
         * on a light theme it used to turn the lights off.
         */
        if (slots.text === "light" || slots.text === "dark") {
          await host.runCommand(`theme.set.${slots.text}`)
          return {
            success: true,
            spoken:
              lang === "en"
                ? `${slots.text === "light" ? "Light" : "Dark"} theme set.`
                : `Tema ${slots.text === "light" ? "chiaro" : "scuro"} impostato.`,
          }
        }
        await host.runCommand("theme.toggle")
        return { success: true, spoken: lang === "en" ? "Visual theme updated." : "Tema visivo aggiornato." }
      }

      case "browser.new": {
        await host.runCommand("browser.new")
        return { success: true, spoken: lang === "en" ? "New browser opened." : "Nuovo browser aperto." }
      }

      case "process.kill": {
        const panes = host.listPanes()
        const resolved = resolveTargetPane(slots, panes, ctx.focusedPaneId, isDestructive, lang)
        if (resolved.error) {
          return { success: false, spoken: resolved.error, error: "pane_not_found" }
        }
        if (!resolved.pane!.hasLiveProcess) {
          return {
            success: false,
            spoken:
              lang === "en"
                ? `Panel «${resolved.pane!.title}» has no active process to terminate.`
                : `Il pannello «${resolved.pane!.title}» non ha un processo attivo da terminare.`,
            error: "no_process",
          }
        }
        host.focusPane(resolved.pane!.id)
        await host.runCommand("process.kill")
        return {
          success: true,
          spoken:
            lang === "en"
              ? `Process in panel «${resolved.pane!.title}» terminated.`
              : `Processo del pannello «${resolved.pane!.title}» terminato.`,
        }
      }

      // 2. Direct VoiceHost methods
      case "pane.list": {
        const panes = host.listPanes()
        if (panes.length === 0) {
          return {
            success: true,
            spoken: lang === "en" ? "No panels currently open." : "Non ci sono pannelli attualmente aperti.",
            data: panes,
          }
        }
        const summaries = panes.map((p) => `${p.index}: ${p.title}`).join(", ")
        return {
          success: true,
          spoken: lang === "en" ? `There are ${panes.length} open panels: ${summaries}.` : `Ci sono ${panes.length} pannelli aperti: ${summaries}.`,
          data: panes,
        }
      }

      case "pane.focus": {
        const panes = host.listPanes()
        const resolved = resolveTargetPane(slots, panes, ctx.focusedPaneId, isDestructive, lang)
        if (resolved.error) {
          return { success: false, spoken: resolved.error, error: "pane_not_found" }
        }
        host.focusPane(resolved.pane!.id)
        return {
          success: true,
          spoken:
            lang === "en"
              ? `Focused panel ${resolved.pane!.index}: ${resolved.pane!.title}.`
              : `Portato il fuoco sul pannello ${resolved.pane!.index}: ${resolved.pane!.title}.`,
        }
      }

      case "prompt.send": {
        const panes = host.listPanes()
        const resolved = resolveTargetPane(slots, panes, ctx.focusedPaneId, isDestructive, lang)
        if (resolved.error) {
          return { success: false, spoken: resolved.error, error: "pane_not_found" }
        }
        const text = slots.text || (lang === "en" ? "continue" : "continua")
        await host.sendPrompt(resolved.pane!.id, text)
        return {
          success: true,
          spoken:
            lang === "en"
              ? `Instruction sent to panel ${resolved.pane!.index}.`
              : `Istruzione inviata al pannello ${resolved.pane!.index}.`,
        }
      }

      case "file.open": {
        if (!slots.path) {
          return {
            success: false,
            spoken: lang === "en" ? "Specify the path of the file to open." : "Specificare il percorso del file da aprire.",
            error: "missing_path",
          }
        }
        await host.openFile(slots.path)
        return {
          success: true,
          spoken: lang === "en" ? `File ${slots.path} opened.` : `File ${slots.path} aperto.`,
        }
      }

      case "project.search": {
        const query = slots.text || ""
        const hits = await host.searchProject(query)
        return {
          success: true,
          spoken:
            lang === "en"
              ? `Found ${hits.length} results for '${query}'.`
              : `Trovati ${hits.length} risultati per '${query}'.`,
          data: hits,
        }
      }

      case "pane.view.set": {
        const panes = host.listPanes()
        const resolved = resolveTargetPane(slots, panes, ctx.focusedPaneId, isDestructive, lang)
        if (resolved.error) {
          return { success: false, spoken: resolved.error, error: "pane_not_found" }
        }
        const viewMode = slots.text === "diff" ? "diff" : "transcript"
        if (host.setPaneView(resolved.pane!.id, viewMode) === false) {
          return {
            success: false,
            spoken: lang === "en" ? "This panel has no view to change." : "Questo pannello non ha una vista da cambiare.",
            error: "unsupported",
          }
        }
        return {
          success: true,
          spoken:
            lang === "en"
              ? `View of panel ${resolved.pane!.index} set to ${viewMode}.`
              : `Visualizzazione del pannello ${resolved.pane!.index} impostata su ${viewMode}.`,
        }
      }

      case "browser.navigate": {
        const panes = host.listPanes()
        const hasExplicitPane =
          slots.paneIndex !== undefined || slots.paneTitle !== undefined || slots.paneId !== undefined
        const candidatePanes =
          hasExplicitPane || panes.filter((p) => p.isBrowser).length === 0
            ? panes
            : panes.filter((p) => p.isBrowser)
        const resolved = resolveTargetPane(slots, candidatePanes, ctx.focusedPaneId, isDestructive, lang)
        if (resolved.error) {
          return { success: false, spoken: resolved.error, error: "pane_not_found" }
        }
        const url = slots.url || "http://localhost:3000"
        if (host.browserNavigate(resolved.pane!.id, url) === false) {
          return {
            success: false,
            spoken: lang === "en" ? "Could not find browser panel to navigate." : "Non ho trovato il pannello browser da far navigare.",
            error: "pane_not_found",
          }
        }
        return {
          success: true,
          spoken: lang === "en" ? `Browser navigated to ${url}.` : `Browser navigato verso ${url}.`,
        }
      }

      case "permission.allow": {
        const panes = host.listPanes()
        const resolved = resolveTargetPane(slots, panes, ctx.focusedPaneId, isDestructive, lang)
        if (resolved.error) {
          return { success: false, spoken: resolved.error, error: "pane_not_found" }
        }
        if (host.answerPermission(resolved.pane!.id, "allow") === false) {
          return {
            success: false,
            spoken: lang === "en" ? "No permission request is pending." : "Non c'è nessuna richiesta di permesso in attesa.",
            error: "no_permission",
          }
        }
        return {
          success: true,
          spoken: lang === "en" ? "Permission granted to the agent." : "Permesso concesso all'agente.",
        }
      }

      case "permission.deny": {
        const panes = host.listPanes()
        const resolved = resolveTargetPane(slots, panes, ctx.focusedPaneId, isDestructive, lang)
        if (resolved.error) {
          return { success: false, spoken: resolved.error, error: "pane_not_found" }
        }
        if (host.answerPermission(resolved.pane!.id, "deny") === false) {
          return {
            success: false,
            spoken:
              lang === "en"
                ? "Did not deny anything: no pending request, or no response that is a denial."
                : "Non ho negato nulla: nessuna richiesta in attesa, o nessuna risposta che sia un rifiuto.",
            error: "no_permission",
          }
        }
        return {
          success: true,
          spoken: lang === "en" ? "Permission denied to the agent." : "Permesso negato all'agente.",
        }
      }

      case "grid.columns.set": {
        const cols = slots.columns !== undefined ? Number(slots.columns) : undefined
        host.setColumns(cols)
        return {
          success: true,
          spoken: cols
            ? (lang === "en" ? `Grid set to ${cols} columns.` : `Disposta la griglia su ${cols} colonne.`)
            : (lang === "en" ? "Column layout reset." : "Disposizione colonne reimpostata."),
        }
      }

      case "view.set": {
        /*
         * `code` is the fallback rather than a refusal: `view.set` only
         * matched because the sentence named a view, and the grid is the one
         * people mean when the word itself did not survive transcription.
         */
        const named = VIEWS.find((view) => view === slots.text)
        const targetView: AdeView = named ?? "code"
        const available = host.availableViews?.() ?? VIEWS
        if (!available.includes(targetView)) {
          return {
            success: false,
            spoken: lang === "en" ? `The ${targetView} section is not available right now.` : `La sezione ${targetView} non è disponibile per ora.`,
            error: "view_unavailable",
          }
        }
        host.setView(targetView)
        return {
          success: true,
          spoken: lang === "en" ? `View set to ${targetView}.` : `Vista impostata su ${targetView}.`,
        }
      }

      case "transcript.scroll": {
        const panes = host.listPanes()
        const resolved = resolveTargetPane(slots, panes, ctx.focusedPaneId, isDestructive, lang)
        if (resolved.error) {
          return { success: false, spoken: resolved.error, error: "pane_not_found" }
        }
        const delta = slots.text === "up" ? -300 : 300
        host.scrollTranscript(resolved.pane!.id, delta)
        return {
          success: true,
          spoken: lang === "en" ? `Panel ${resolved.pane!.index} transcript scrolled.` : `Trascrizione del pannello ${resolved.pane!.index} scorsa.`,
        }
      }

      case "state.describe": {
        const snapshot = host.describeState()
        return {
          success: true,
          spoken: snapshot.spokenSummary,
          data: snapshot,
        }
      }

      // 3. Spoken dialogue information outcomes
      case "help.list": {
        return {
          success: true,
          spoken:
            lang === "en"
              ? "You can ask me to open new sessions, change view, terminate processes, search the project, open files, and dictate instructions for agents."
              : "Puoi chiedermi di aprire nuove sessioni, cambiare vista, terminare processi, cercare nel progetto, aprire file e dettare istruzioni per gli agenti.",
        }
      }

      case "voice.sleep": {
        return {
          success: true,
          spoken: lang === "en" ? "Voice listening suspended." : "Ascolto vocale sospeso.",
        }
      }

      case "voice.wake": {
        return {
          success: true,
          spoken: lang === "en" ? "Voice listening active and ready." : "Ascolto vocale attivo e pronto.",
        }
      }

      /*
       * Reaching the dispatcher means the dialogue had nothing of the kind in
       * progress, so nothing was confirmed, cancelled or sent: saying so beats
       * «Confermato» for an action that never ran.
       */
      case "dialog.confirm": {
        return { success: false, spoken: lang === "en" ? "Nothing to confirm." : "Non c'è niente da confermare.", error: "nothing_pending" }
      }

      case "dialog.cancel": {
        return { success: false, spoken: lang === "en" ? "Nothing to cancel." : "Non c'è niente da annullare.", error: "nothing_pending" }
      }

      case "dialog.repeat": {
        return {
          success: true,
          spoken: lang === "en" ? "Repeating last message." : "Ripeto l'ultimo messaggio.",
        }
      }

      case "dictation.start": {
        return {
          success: true,
          spoken: lang === "en" ? "Dictation mode started." : "Modalità dettatura avviata.",
        }
      }

      case "dictation.finish": {
        return { success: false, spoken: lang === "en" ? "No ongoing dictation to send." : "Non c'è una dettatura in corso da inviare.", error: "nothing_pending" }
      }

      default:
        return {
          success: false,
          spoken: lang === "en" ? `Intent '${intentId}' not handled by dispatcher.` : `Intento '${intentId}' non gestito dal dispatcher.`,
          error: "unhandled_intent",
        }
    }
  } catch (err: any) {
    return {
      success: false,
      // Said in plain words; the error itself stays written in `error`.
      spoken: plainFailure(err?.message, lang),
      error: String(err),
    }
  }
}

/** What to say when a command threw: the cause in plain words, never the raw message. */
export function plainFailure(message: string | undefined, lang: "it" | "en" = "it"): string {
  const plain = plainProblem(message, lang)
  if (lang === "en") {
    if (plain) return `Could not complete action. ${plain}`
    if (message && writtenForPeople(message)) return `Could not complete action: ${message.trim()}`
    return "Could not complete action in ADE: see console for details."
  }
  if (plain) return `Non sono riuscito a farlo. ${plain}`
  // A host that threw a sentence meant for the user («non c'è nessun progetto aperto») is read as it is.
  if (message && writtenForPeople(message)) return `Non sono riuscito a farlo: ${message.trim()}`
  return "Non sono riuscito a farlo in ADE: trovi il dettaglio nella console."
}

/* Short, and nothing of a program's own vocabulary in it. */
function writtenForPeople(message: string): boolean {
  if (message.length > 160) return false
  if (/[{}<>[\]_\\/=]/.test(message)) return false
  if (/\b(?:E[A-Z]{3,}|[A-Z]\w*Error)\b/.test(message)) return false
  return !/\b(?:error|cannot|undefined|null|failed|exception|is not|not found|reading)\b/i.test(message)
}
