import { createSignal } from "solid-js"
import { Overlay, Surface } from "../ui/layout"
import type { RecordConsent } from "./record-panel"
import type { RecordTarget } from "./recording"

/**
 * The question ADE asks before an agent films it (S36).
 *
 * Every take, no remembered yes: a video shows everything on screen for as
 * long as it runs. The microphone is a separate switch, off until the user
 * turns it on for this take. Esc, a click outside and «No» all refuse, because
 * the safe answer must be the one you get by doing nothing.
 */
export function RecordConsentDialog(props: { target: RecordTarget; onAnswer: (answer: RecordConsent) => void }) {
  const [mic, setMic] = createSignal(false)
  const refuse = () => props.onAnswer({ allowed: false, mic: false })
  const what = () => (props.target.kind === "pane" ? `il pannello ${props.target.paneId}` : "tutta la finestra di ADE")
  return (
    <Overlay
      data-component="record-consent"
      place="center"
      onClose={refuse}
      onKeyDown={(event) => {
        if (event.key === "Escape") refuse()
      }}
    >
      <Surface size="sm" role="alertdialog" aria-modal="true" aria-label="Registrazione chiesta da un agente">
        <header data-slot="sheet-head">
          <strong>Registrare un video?</strong>
        </header>
        <div data-slot="record-consent-body">
          <p>Un agente chiede di registrare {what()}.</p>
          <p data-slot="record-consent-note">
            Il video riprende tutto quello che appare finché non la fermi dal pulsante REC. I campi con chiavi e
            password vengono oscurati.
          </p>
          <label data-slot="record-consent-mic">
            <input type="checkbox" checked={mic()} onChange={(event) => setMic(event.currentTarget.checked)} />
            Registra anche il microfono
          </label>
        </div>
        <footer data-slot="record-consent-actions">
          <button
            type="button"
            data-slot="decision-ghost"
            ref={(button) => queueMicrotask(() => button.focus())}
            onClick={refuse}
          >
            No
          </button>
          <button
            type="button"
            data-slot="decision-submit"
            onClick={() => props.onAnswer({ allowed: true, mic: mic() })}
          >
            Registra
          </button>
        </footer>
      </Surface>
    </Overlay>
  )
}
