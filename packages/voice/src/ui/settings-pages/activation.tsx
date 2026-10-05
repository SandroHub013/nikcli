/** Voce › Attivazione: how listening starts. */
import { Show, type JSX } from "solid-js"
import { t } from "@nikcli-ai/ade/i18n"
import { wakeWordEnabled, shortcutActivationEnabled } from "../../settings/model"
import { describeShortcut } from "../../settings/shortcuts"
import { formatSpendCost } from "../../settings/spend"
import type { VoiceSettingsState } from "../settings-state"
import { PageHead } from "./head"

export function ActivationPage(p: { state: VoiceSettingsState; bare?: boolean }): JSX.Element {
  const { props, platform, updateSettings, selectActivation, listenKeys, activationKeys } = p.state
  return (
    <>
      <PageHead
        id="section-activation-title"
        title={t("vui.activation.title")}
        desc={t("vui.activation.desc")}
        bare={p.bare}
      />
      <div
        role="radiogroup"
        aria-labelledby="section-activation-title"
        data-slot="activation-list"
        onKeyDown={activationKeys}
      >
        {/* Push to talk: behind SHORTCUT_ACTIVATION_ENABLED, off: the name is the only way */}
        <Show when={shortcutActivationEnabled()}>
          <div
            role="radio"
            data-value="push-to-talk"
            aria-checked={props.settings.activation === "push-to-talk"}
            tabIndex={props.settings.activation === "push-to-talk" ? 0 : -1}
            data-slot="activation-item"
            onClick={() => selectActivation("push-to-talk")}
          >
            <div data-slot="item-text-group">
              <span data-slot="item-title">{t("vui.activation.push")}</span>
              <span data-slot="item-desc">{t("vui.activation.push.desc")}</span>
            </div>
            <kbd data-slot="chord-chip">
              {describeShortcut(
                props.settings.mode === "transcription" ? props.settings.transcriptionChord : props.settings.agentChord,
                platform,
              )}
            </kbd>
          </div>
        </Show>

        {/* Toggle continuous: behind both switches, off */}
        <Show when={wakeWordEnabled() && shortcutActivationEnabled()}>
          <div
            role="radio"
            data-value="toggle"
            aria-checked={props.settings.activation === "toggle"}
            tabIndex={props.settings.activation === "toggle" ? 0 : -1}
            data-slot="activation-item"
            onClick={() => selectActivation("toggle")}
          >
            <div data-slot="item-text-group">
              <span data-slot="item-title">{t("vui.activation.toggle")}</span>
              <span data-slot="item-desc">{t("vui.activation.toggle.desc")}</span>
            </div>
            <kbd data-slot="chord-chip">
              {describeShortcut(
                props.settings.mode === "transcription" ? props.settings.transcriptionChord : props.settings.agentChord,
                platform,
              )}
            </kbd>
          </div>
        </Show>

        <Show when={props.settingsNotice}>
          {(text) => (
            // Informational, not a failure: nothing went wrong, a default changed.
            <div data-slot="reason-box" data-tone="muted" role="status">
              {text()}
            </div>
          )}
        </Show>
        {/* Wake Word: behind WAKE_WORD_ENABLED, off in 0.7.0 */}
        <Show when={wakeWordEnabled()}>
          <div data-slot="activation-group">
            <div
              role="radio"
              data-value="wake-word"
              aria-checked={props.settings.mode === "agent" && props.settings.activation === "wake-word"}
              aria-disabled={props.settings.mode === "transcription" ? "true" : undefined}
              aria-describedby={props.settings.mode === "transcription" ? "wake-word-disabled-reason" : undefined}
              tabIndex={props.settings.mode === "agent" && props.settings.activation === "wake-word" ? 0 : -1}
              data-slot="activation-item"
              onClick={() => selectActivation("wake-word")}
            >
              <div data-slot="item-text-group">
                <span data-slot="item-title">{t("vui.activation.wake")}</span>
                <span data-slot="item-desc">{t("vui.activation.wake.desc")}</span>
              </div>
              <Show when={props.settings.mode === "agent"}>
                <kbd data-slot="chord-chip">«{props.settings.wakeWord}»</kbd>
              </Show>
            </div>

            {/* Disabled reason in transcription mode */}
            <Show when={props.settings.mode === "transcription"}>
              <div id="wake-word-disabled-reason" data-slot="reason-box" data-tone="muted">
                {t("vui.activation.wake.disabled")}
              </div>
            </Show>

            {/* The phrase is fixed; what can be chosen is whether ADE listens by itself. */}
            <Show when={props.settings.mode === "agent" && props.settings.activation === "wake-word"}>
              <div data-slot="sub-choice-box">
                <span id="listen-label" data-slot="sub-choice-label">
                  {t("vui.listen.title")}
                </span>
                <div
                  role="radiogroup"
                  aria-labelledby="listen-label"
                  aria-describedby="wake-word-hint"
                  data-slot="sub-choice-row"
                  onKeyDown={listenKeys}
                >
                  <div
                    role="radio"
                    data-value="always"
                    aria-checked={props.settings.alwaysListen !== false}
                    tabIndex={props.settings.alwaysListen !== false ? 0 : -1}
                    data-slot="sub-choice-item"
                    onClick={() => updateSettings({ alwaysListen: true })}
                  >
                    <span data-slot="sub-item-title">{t("vui.listen.always")}</span>
                    <span data-slot="sub-item-desc">{t("vui.listen.always.desc", props.settings.wakeWord)}</span>
                  </div>
                  <div
                    role="radio"
                    data-value="manual"
                    aria-checked={props.settings.alwaysListen === false}
                    tabIndex={props.settings.alwaysListen === false ? 0 : -1}
                    data-slot="sub-choice-item"
                    onClick={() => updateSettings({ alwaysListen: false })}
                  >
                    <span data-slot="sub-item-title">{t("vui.listen.manual")}</span>
                    <span data-slot="sub-item-desc">{t("vui.listen.manual.desc")}</span>
                  </div>
                </div>
                <p id="wake-word-hint" data-slot="hint">
                  {t("vui.wake.hint", props.settings.wakeWord)}
                </p>
                {/* What listening has spent today, where the switch that spends it is. */}
                <p data-slot="hint" data-testid="listen-spend">
                  {t(
                    "vui.listen.spend",
                    props.engine.listenSpend().calls,
                    formatSpendCost(props.engine.listenSpend().cost),
                  )}
                </p>
              </div>
            </Show>
          </div>
        </Show>
      </div>
    </>
  )
}
