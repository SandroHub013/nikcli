/**
 * Intent dispatcher translating parsed voice intents into concrete VoiceHost calls.
 *
 * Handles:
 * - 1-based index and fuzzy title resolution for target panes
 * - Safe error handling: non-existent panes or failed host actions return
 *   spoken Italian error messages rather than unhandled rejections
 * - Italian speech readback for all dispatched operations
 */

import { fuzzyMatch } from "@nikcli-ai/ade/command/match"
import type { ParseResult } from "../intent/parse"
import type { AdeView, PaneSummary, VoiceHost } from "./host"

/** The view names `view.set` accepts, in the order the chrome shows them. */
const VIEWS: readonly AdeView[] = ["agent", "code", "chat", "bot"]

export interface DispatchContext {
  /** ID of the currently focused pane in ADE, if any. */
  focusedPaneId?: string
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
  destructive = false
): { pane?: PaneSummary; error?: string } {
  if (panes.length === 0) {
    return { error: "Nessun pannello attualmente aperto su ADE." }
  }

  // 1. By 1-based index
  if (slots.paneIndex !== undefined) {
    const targetIdx = Number(slots.paneIndex)
    const found = panes.find((p) => p.index === targetIdx)
    if (!found) {
      return { error: `Pannello numero ${targetIdx} non trovato.` }
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
      return { error: `Nessun pannello corrispondente a '${slots.paneTitle}' trovato.` }
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
  if (result.outcome !== "matched" || !result.intent) {
    return {
      success: false,
      spoken: "Non è stato possibile eseguire il comando vocale.",
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
        await host.runCommand("session.new")
        return { success: true, spoken: "Nuova sessione avviata." }
      }

      case "palette.open": {
        await host.runCommand("palette.open")
        return { success: true, spoken: "Tavolozza dei comandi aperta." }
      }

      case "project.open": {
        await host.runCommand("project.open")
        return { success: true, spoken: "Apro la selezione del progetto." }
      }

      case "project.recent": {
        const root = slots.path ? `project.recent.${slots.path}` : "project.recent"
        await host.runCommand(root)
        return { success: true, spoken: "Apro il progetto recente richiesto." }
      }

      case "pane.close": {
        const panes = host.listPanes()
        const resolved = resolveTargetPane(slots, panes, ctx.focusedPaneId, isDestructive)
        if (resolved.error) {
          return { success: false, spoken: resolved.error, error: "pane_not_found" }
        }
        host.focusPane(resolved.pane!.id)
        await host.runCommand("pane.close")
        return {
          success: true,
          spoken: `Pannello ${resolved.pane!.index} chiuso.`,
        }
      }

      case "pane.expand": {
        const panes = host.listPanes()
        const resolved = resolveTargetPane(slots, panes, ctx.focusedPaneId, isDestructive)
        if (resolved.error) {
          return { success: false, spoken: resolved.error, error: "pane_not_found" }
        }
        host.focusPane(resolved.pane!.id)
        await host.runCommand("pane.expand")
        return {
          success: true,
          spoken: `Dimensione del pannello ${resolved.pane!.index} modificata.`,
        }
      }

      case "view.toggle": {
        await host.runCommand("view.toggle")
        return { success: true, spoken: "Vista cambiata." }
      }

      case "theme.toggle": {
        await host.runCommand("theme.toggle")
        return { success: true, spoken: "Tema visivo aggiornato." }
      }

      case "browser.new": {
        await host.runCommand("browser.new")
        return { success: true, spoken: "Nuovo browser aperto." }
      }

      case "process.kill": {
        const panes = host.listPanes()
        const resolved = resolveTargetPane(slots, panes, ctx.focusedPaneId, isDestructive)
        if (resolved.error) {
          return { success: false, spoken: resolved.error, error: "pane_not_found" }
        }
        host.focusPane(resolved.pane!.id)
        await host.runCommand("process.kill")
        return {
          success: true,
          spoken: `Processo del pannello ${resolved.pane!.index} terminato.`,
        }
      }

      // 2. Direct VoiceHost methods
      case "pane.list": {
        const panes = host.listPanes()
        if (panes.length === 0) {
          return {
            success: true,
            spoken: "Non ci sono pannelli attualmente aperti.",
            data: panes,
          }
        }
        const summaries = panes.map((p) => `${p.index}: ${p.title}`).join(", ")
        return {
          success: true,
          spoken: `Ci sono ${panes.length} pannelli aperti: ${summaries}.`,
          data: panes,
        }
      }

      case "pane.focus": {
        const panes = host.listPanes()
        const resolved = resolveTargetPane(slots, panes, ctx.focusedPaneId, isDestructive)
        if (resolved.error) {
          return { success: false, spoken: resolved.error, error: "pane_not_found" }
        }
        host.focusPane(resolved.pane!.id)
        return {
          success: true,
          spoken: `Portato il fuoco sul pannello ${resolved.pane!.index}: ${resolved.pane!.title}.`,
        }
      }

      case "prompt.send": {
        const panes = host.listPanes()
        const resolved = resolveTargetPane(slots, panes, ctx.focusedPaneId, isDestructive)
        if (resolved.error) {
          return { success: false, spoken: resolved.error, error: "pane_not_found" }
        }
        const text = slots.text || "continua"
        await host.sendPrompt(resolved.pane!.id, text)
        return {
          success: true,
          spoken: `Istruzione inviata al pannello ${resolved.pane!.index}.`,
        }
      }

      case "file.open": {
        if (!slots.path) {
          return {
            success: false,
            spoken: "Specificare il percorso del file da aprire.",
            error: "missing_path",
          }
        }
        await host.openFile(slots.path)
        return {
          success: true,
          spoken: `File ${slots.path} aperto.`,
        }
      }

      case "project.search": {
        const query = slots.text || ""
        const hits = await host.searchProject(query)
        return {
          success: true,
          spoken: `Trovati ${hits.length} risultati per '${query}'.`,
          data: hits,
        }
      }

      case "pane.view.set": {
        const panes = host.listPanes()
        const resolved = resolveTargetPane(slots, panes, ctx.focusedPaneId, isDestructive)
        if (resolved.error) {
          return { success: false, spoken: resolved.error, error: "pane_not_found" }
        }
        const viewMode = slots.text === "diff" ? "diff" : "transcript"
        host.setPaneView(resolved.pane!.id, viewMode)
        return {
          success: true,
          spoken: `Visualizzazione del pannello ${resolved.pane!.index} impostata su ${viewMode}.`,
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
        const resolved = resolveTargetPane(slots, candidatePanes, ctx.focusedPaneId, isDestructive)
        if (resolved.error) {
          return { success: false, spoken: resolved.error, error: "pane_not_found" }
        }
        const url = slots.url || "http://localhost:3000"
        host.browserNavigate(resolved.pane!.id, url)
        return {
          success: true,
          spoken: `Browser navigato verso ${url}.`,
        }
      }

      case "permission.allow": {
        const panes = host.listPanes()
        const resolved = resolveTargetPane(slots, panes, ctx.focusedPaneId, isDestructive)
        if (resolved.error) {
          return { success: false, spoken: resolved.error, error: "pane_not_found" }
        }
        host.answerPermission(resolved.pane!.id, "allow")
        return {
          success: true,
          spoken: "Permesso concesso all'agente.",
        }
      }

      case "permission.deny": {
        const panes = host.listPanes()
        const resolved = resolveTargetPane(slots, panes, ctx.focusedPaneId, isDestructive)
        if (resolved.error) {
          return { success: false, spoken: resolved.error, error: "pane_not_found" }
        }
        host.answerPermission(resolved.pane!.id, "deny")
        return {
          success: true,
          spoken: "Permesso negato all'agente.",
        }
      }

      case "grid.columns.set": {
        const cols = slots.columns !== undefined ? Number(slots.columns) : undefined
        host.setColumns(cols)
        return {
          success: true,
          spoken: cols ? `Disposta la griglia su ${cols} colonne.` : "Disposizione colonne reimpostata.",
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
        host.setView(targetView)
        return {
          success: true,
          spoken: `Vista impostata su ${targetView}.`,
        }
      }

      case "transcript.scroll": {
        const panes = host.listPanes()
        const resolved = resolveTargetPane(slots, panes, ctx.focusedPaneId, isDestructive)
        if (resolved.error) {
          return { success: false, spoken: resolved.error, error: "pane_not_found" }
        }
        const delta = slots.text === "up" ? -300 : 300
        host.scrollTranscript(resolved.pane!.id, delta)
        return {
          success: true,
          spoken: `Trascrizione del pannello ${resolved.pane!.index} scorsa.`,
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
            "Puoi chiedermi di aprire nuove sessioni, cambiare vista, terminare processi, " +
            "cercare nel progetto, aprire file e dettare istruzioni per gli agenti.",
        }
      }

      case "voice.sleep": {
        return {
          success: true,
          spoken: "Ascolto vocale sospeso.",
        }
      }

      case "voice.wake": {
        return {
          success: true,
          spoken: "Ascolto vocale attivo e pronto.",
        }
      }

      case "dialog.confirm": {
        return {
          success: true,
          spoken: "Confermato.",
        }
      }

      case "dialog.cancel": {
        return {
          success: true,
          spoken: "Operazione annullata.",
        }
      }

      case "dialog.repeat": {
        return {
          success: true,
          spoken: "Ripeto l'ultimo messaggio.",
        }
      }

      case "dictation.start": {
        return {
          success: true,
          spoken: "Modalità dettatura avviata.",
        }
      }

      case "dictation.finish": {
        return {
          success: true,
          spoken: "Dettatura completata.",
        }
      }

      default:
        return {
          success: false,
          spoken: `Intento '${intentId}' non gestito dal dispatcher.`,
          error: "unhandled_intent",
        }
    }
  } catch (err: any) {
    return {
      success: false,
      spoken: `Si è verificato un errore durante l'esecuzione del comando: ${err?.message ?? "errore sconosciuto"}`,
      error: String(err),
    }
  }
}
