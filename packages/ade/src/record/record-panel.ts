/**
 * `@ade record …`: an agent starts and stops a take (S36).
 *
 * The same protocol the video, 3D and simulator panels use, so an agent
 * scripting a demo needs nothing new to learn. Recording is not a panel the
 * user opens, so the verbs are always available while ADE is running.
 */

import type { PanelOutcome, PanelRequest, PanelVerb } from "../panels/protocol"
import type { RecordTarget } from "./recording"

export const RECORD_VERBS: readonly PanelVerb[] = [
  { name: "start", usage: "start [pannello]", summary: "registra la finestra, o il pannello indicato" },
  { name: "stop", usage: "stop", summary: "chiude la registrazione e scrive il file eventi" },
  { name: "state", usage: "state", summary: "dice se si sta registrando e dove" },
]

export interface RecordPanelDeps {
  start: (target: RecordTarget) => Promise<string | undefined>
  stop: () => Promise<string | undefined>
  /** The pane's rectangle in window pixels, or undefined when there is no such pane. */
  paneRect: (name: string) => { x: number; y: number; width: number; height: number } | undefined
  state: () => { recording: boolean; path?: string }
}

export async function runRecordRequest(request: PanelRequest, deps: RecordPanelDeps): Promise<PanelOutcome> {
  switch (request.verb) {
    case "start": {
      const pane = request.args[0]
      let target: RecordTarget = { kind: "window" }
      if (pane) {
        const rect = deps.paneRect(pane)
        if (!rect) return { ok: false, reason: `nessun pannello "${pane}" da registrare` }
        // The rectangle travels with the target: the host crops each frame.
        target = { kind: "pane", paneId: pane, ...rect }
      }
      const problem = await deps.start(target)
      return problem ? { ok: false, reason: problem } : { ok: true, detail: pane ? `registro il pannello ${pane}` : "registro la finestra" }
    }
    case "stop": {
      const before = deps.state()
      if (!before.recording) return { ok: false, reason: "non si sta registrando" }
      const problem = await deps.stop()
      return problem ? { ok: false, reason: problem } : { ok: true, detail: before.path ? `salvato in ${before.path}` : "registrazione chiusa" }
    }
    case "state": {
      const now = deps.state()
      return { ok: true, detail: now.recording ? `registro in ${now.path ?? "corso"}` : "nessuna registrazione" }
    }
    default:
      return { ok: false, reason: `comando sconosciuto: ${request.verb}` }
  }
}
