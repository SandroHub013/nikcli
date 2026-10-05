/** Voce › Scorciatoie: the two chords, recorded here. */
import { Show, type JSX } from "solid-js"
import { t } from "@nikcli-ai/ade/i18n"
import { DEFAULT_VOICE_SETTINGS } from "../../settings/model"
import { describeShortcut } from "../../settings/shortcuts"
import type { VoiceSettingsState } from "../settings-state"
import { PageHead } from "./head"

export function ShortcutsPage(p: { state: VoiceSettingsState; bare?: boolean }): JSX.Element {
  const {
    props,
    platform,
    recordingField,
    agentWarning,
    transcriptionWarning,
    updateSettings,
    handleShortcutKeyDown,
    startRecording,
    stopRecording,
    resetChord,
    shortcutIssue,
    recordingLabel,
    pressKeys,
  } = p.state
  return (
    <>
      <PageHead
        id="section-shortcuts-title"
        title={t("vui.shortcuts.title")}
        desc={t("vui.shortcuts.desc")}
        bare={p.bare}
      />
      <div data-slot="shortcuts-list">
        {/* Agent Shortcut */}
        <div>
          <div data-slot="shortcut-row">
            <div data-slot="item-text-group">
              <label for="agent-chord-btn" data-slot="item-title">
                {t("vui.shortcuts.agent")}
              </label>
              <span id="agent-chord-desc" data-slot="item-desc">
                {t("vui.shortcuts.agent.desc")}
              </span>
            </div>
            <div data-slot="shortcut-controls">
              <button
                id="agent-chord-btn"
                type="button"
                data-slot="shortcut-recorder-btn"
                data-recording={recordingField() === "agent" ? "true" : undefined}
                aria-describedby="agent-chord-desc"
                onClick={() => startRecording("agent")}
                onBlur={() => stopRecording("agent")}
                onKeyDown={(e) => {
                  if (recordingField() === "agent") {
                    handleShortcutKeyDown("agent", e)
                  }
                }}
              >
                {recordingField() === "agent"
                  ? recordingLabel()
                  : describeShortcut(props.settings.agentChord, platform)}
              </button>
              <button
                type="button"
                data-slot="ghost-btn"
                aria-label={t("vui.shortcuts.agent.reset")}
                disabled={props.settings.agentChord === DEFAULT_VOICE_SETTINGS.agentChord}
                onClick={() => resetChord("agent")}
              >
                {t("vui.shortcuts.reset")}
              </button>
            </div>
          </div>
          <Show when={shortcutIssue("agent")}>
            {(issue) => (
              <div role="alert" data-slot="reason-box">
                {issue()}
              </div>
            )}
          </Show>
          <Show when={agentWarning()}>
            {(warning) => (
              <div role="status" data-slot="reason-box" data-tone="muted">
                {t("vui.shortcuts.saved", warning())}
              </div>
            )}
          </Show>
        </div>

        {/* Transcription Shortcut */}
        <div>
          <div data-slot="shortcut-row">
            <div data-slot="item-text-group">
              <label for="transcription-chord-btn" data-slot="item-title">
                {t("vui.shortcuts.transcription")}
              </label>
              <span id="transcription-chord-desc" data-slot="item-desc">
                {t(
                  props.settings.dictationPress === "toggle"
                    ? "vui.shortcuts.transcription.desc.toggle"
                    : "vui.shortcuts.transcription.desc",
                )}
              </span>
            </div>
            <div data-slot="shortcut-controls">
              <button
                id="transcription-chord-btn"
                type="button"
                data-slot="shortcut-recorder-btn"
                data-recording={recordingField() === "transcription" ? "true" : undefined}
                aria-describedby="transcription-chord-desc"
                onClick={() => startRecording("transcription")}
                onBlur={() => stopRecording("transcription")}
                onKeyDown={(e) => {
                  if (recordingField() === "transcription") {
                    handleShortcutKeyDown("transcription", e)
                  }
                }}
              >
                {recordingField() === "transcription"
                  ? recordingLabel()
                  : describeShortcut(props.settings.transcriptionChord, platform)}
              </button>
              <button
                type="button"
                data-slot="ghost-btn"
                aria-label={t("vui.shortcuts.transcription.reset")}
                disabled={props.settings.transcriptionChord === DEFAULT_VOICE_SETTINGS.transcriptionChord}
                onClick={() => resetChord("transcription")}
              >
                {t("vui.shortcuts.reset")}
              </button>
            </div>
          </div>
          <Show when={shortcutIssue("transcription")}>
            {(issue) => (
              <div role="alert" data-slot="reason-box">
                {issue()}
              </div>
            )}
          </Show>
          <Show when={transcriptionWarning()}>
            {(warning) => (
              <div role="status" data-slot="reason-box" data-tone="muted">
                {t("vui.shortcuts.saved", warning())}
              </div>
            )}
          </Show>
          <div data-slot="sub-choice-box">
            <span id="dictation-press-label" data-slot="sub-choice-label">
              {t("vui.dictation.press.title")}
            </span>
            <div
              role="radiogroup"
              aria-labelledby="dictation-press-label"
              data-slot="sub-choice-row"
              onKeyDown={pressKeys}
            >
              <div
                role="radio"
                data-value="hold"
                aria-checked={props.settings.dictationPress !== "toggle"}
                tabIndex={props.settings.dictationPress !== "toggle" ? 0 : -1}
                data-slot="sub-choice-item"
                onClick={() => updateSettings({ dictationPress: "hold" })}
              >
                <span data-slot="sub-item-title">{t("vui.dictation.press.hold")}</span>
                <span data-slot="sub-item-desc">{t("vui.dictation.press.hold.desc")}</span>
              </div>
              <div
                role="radio"
                data-value="toggle"
                aria-checked={props.settings.dictationPress === "toggle"}
                tabIndex={props.settings.dictationPress === "toggle" ? 0 : -1}
                data-slot="sub-choice-item"
                onClick={() => updateSettings({ dictationPress: "toggle" })}
              >
                <span data-slot="sub-item-title">{t("vui.dictation.press.toggle")}</span>
                <span data-slot="sub-item-desc">{t("vui.dictation.press.toggle.desc")}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}
