import { Show, type JSX } from "solid-js"
import { t } from "@nikcli-ai/ade/i18n"
import type { VoiceEngine } from "../../engine"
import { NikMic } from "../nik-mic"
import type { VoiceSettingsState } from "../settings-state"

/*
 * The voice's own controls, outside any page: the microphone, its state, the
 * reset of the voice settings, and the button that starts listening.
 *
 * The standalone panel draws them in its header and its console. ADE draws
 * them only in the Voce category — the bar above the page, the button in the
 * footer — because in any other category they offered to reset or start
 * something that page does not show.
 */

/** The microphone, with an aura that follows the level while it listens. */
export function MicMark(p: { state: VoiceSettingsState }): JSX.Element {
  const { engineRunning, micLevel } = p.state
  return (
    <div data-slot="header-mark" aria-hidden="true">
      <span
        data-slot="header-aura"
        style={{
          transform: `scale(${1 + Math.min(micLevel() * 1.6, 0.55)})`,
          opacity: `${engineRunning() ? Math.min(0.25 + micLevel() * 1.5, 0.9) : 0}`,
        }}
      />
      <NikMic size={18} variant="line" />
    </div>
  )
}

/** «Spento», «In ascolto»…: what the voice is doing. */
export function StatusPill(p: { state: VoiceSettingsState }): JSX.Element {
  const { engineStatus } = p.state
  return (
    <div data-slot="status-pill" data-tone={engineStatus().tone} role="status">
      <span data-slot="status-dot" aria-hidden="true" />
      {engineStatus().label}
    </div>
  )
}

/**
 * «Ripristina la voce».
 *
 * It resets DEFAULT_VOICE_SETTINGS and nothing else, the transcription engine
 * included, which comes back on `openrouter`; so it names the voice, and it
 * asks once before it does it.
 */
export function ResetVoiceButton(p: { state: VoiceSettingsState }): JSX.Element {
  const { resetArmed, setResetArmed, restoreDefaults } = p.state
  return (
    <button
      type="button"
      data-slot="ghost-btn"
      data-armed={resetArmed() ? "true" : undefined}
      onClick={restoreDefaults}
      onBlur={() => setResetArmed(false)}
    >
      {resetArmed() ? t("vui.panel.resetVoiceConfirm") : t("vui.panel.resetVoice")}
    </button>
  )
}

/** «Annulla» while it listens, and «Avvia ascolto» / «Ferma ascolto». */
export function ListenActions(p: { engine: VoiceEngine }): JSX.Element {
  const running = () => p.engine.isRunning()
  return (
    <>
      <Show when={running()}>
        <button
          type="button"
          data-slot="ghost-btn"
          onClick={() => void p.engine.cancel()}
          title={t("vui.live.cancel.tip")}
        >
          {t("vui.live.cancel")}
        </button>
      </Show>
      <button
        type="button"
        data-slot="primary-btn"
        data-listening={running() ? "true" : undefined}
        onClick={() => void p.engine.toggle()}
        aria-pressed={running()}
      >
        {running() ? t("vui.live.stop") : t("vui.live.start")}
      </button>
    </>
  )
}

/** The bar ADE puts above a voice page: microphone, what it hears, state, reset. */
export function VoiceStatusBar(p: { state: VoiceSettingsState }): JSX.Element {
  const { props, engineStatus, liveLine } = p.state
  return (
    <div
      data-component="voice-settings-panel"
      data-embedded="true"
      data-part="status"
      data-status={engineStatus().tone}
    >
      <div data-slot="status-bar">
        <MicMark state={p.state} />
        <div data-slot="live-text">
          <p data-slot="live-line" data-kind={liveLine().kind}>
            {liveLine().text}
          </p>
          <Show when={props.engine.lastError()}>
            <p data-slot="live-error" role="alert">
              {props.engine.lastError()}
            </p>
          </Show>
        </div>
        <StatusPill state={p.state} />
        <ResetVoiceButton state={p.state} />
      </div>
    </div>
  )
}

/** «Avvia ascolto», on its own: ADE puts it in the Voce category's footer. */
export function VoiceListenButton(p: { engine: VoiceEngine }): JSX.Element {
  return (
    <div data-component="voice-settings-panel" data-embedded="true" data-part="listen">
      <ListenActions engine={p.engine} />
    </div>
  )
}
