/** Voce › Modalità: what the microphone does by default, and how the agent answers. */
import { Show, For, type JSX } from "solid-js"
import { t } from "@nikcli-ai/ade/i18n"
import { describeShortcut } from "../../settings/shortcuts"
import type { AgentEngine, AgentSpeed } from "../../settings/model"
import type { VoiceSettingsState } from "../settings-state"
import { PageHead } from "./head"

/** The agent engines, as the panel offers them. */
const AGENT_ENGINE_CHOICES: readonly { value: AgentEngine; readonly title: string; readonly desc: string }[] = [
  {
    value: "auto",
    get title() {
      return t("vui.engine.auto")
    },
    get desc() {
      return t("vui.engine.auto.desc")
    },
  },
  {
    value: "claude",
    title: "Claude Code",
    get desc() {
      return t("vui.engine.claude.desc")
    },
  },
  {
    value: "codex",
    title: "Codex",
    get desc() {
      return t("vui.engine.codex.desc")
    },
  },
  {
    value: "nikcli",
    title: "nikcli",
    get desc() {
      return t("vui.engine.nikcli.desc")
    },
  },
  {
    value: "off",
    get title() {
      return t("vui.engine.off")
    },
    get desc() {
      return t("vui.engine.off.desc")
    },
  },
]

const AGENT_SPEED_CHOICES: readonly { value: AgentSpeed; readonly title: string; readonly desc: string }[] = [
  {
    value: "fast",
    get title() {
      return t("vui.speed.fast")
    },
    get desc() {
      return t("vui.speed.fast.desc")
    },
  },
  {
    value: "cli",
    get title() {
      return t("vui.speed.cli")
    },
    get desc() {
      return t("vui.speed.cli.desc")
    },
  },
]

export function ModePage(p: { state: VoiceSettingsState; bare?: boolean }): JSX.Element {
  const {
    props,
    platform,
    updateSettings,
    selectMode,
    modeKeys,
    sendKeys,
    replyKeys,
    alertsKeys,
    engineKeys,
    speedKeys,
    fallbackKeys,
  } = p.state
  return (
    <>
      <PageHead id="section-mode-title" title={t("vui.mode.title")} desc={t("vui.mode.desc")} bare={p.bare} />
      <div role="radiogroup" aria-labelledby="section-mode-title" data-slot="mode-grid" onKeyDown={modeKeys}>
        {/* Agent Mode */}
        <div
          role="radio"
          data-value="agent"
          aria-checked={props.settings.mode === "agent"}
          tabIndex={props.settings.mode === "agent" ? 0 : -1}
          data-slot="mode-card"
          onClick={() => selectMode("agent")}
        >
          <div data-slot="mode-card-header">
            <span data-slot="mode-card-icon" aria-hidden="true">
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.7"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path d="m5 12 4 4 10-10" />
              </svg>
            </span>
            <span data-slot="mode-card-title">{t("vui.mode.agent")}</span>
            <Show when={props.settings.mode === "agent"}>
              <span data-slot="mode-card-badge">{t("vui.mode.active")}</span>
            </Show>
          </div>
          <div data-slot="mode-card-desc">{t("vui.mode.agent.desc")}</div>
          <div data-slot="mode-card-chord">{describeShortcut(props.settings.agentChord, platform)}</div>
        </div>

        {/* Transcription Mode */}
        <div
          role="radio"
          data-value="transcription"
          aria-checked={props.settings.mode === "transcription"}
          tabIndex={props.settings.mode === "transcription" ? 0 : -1}
          data-slot="mode-card"
          onClick={() => selectMode("transcription")}
        >
          <div data-slot="mode-card-header">
            <span data-slot="mode-card-icon" aria-hidden="true">
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.7"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path d="M4 7h16M4 12h11M4 17h7" />
              </svg>
            </span>
            <span data-slot="mode-card-title">{t("vui.mode.transcription")}</span>
            <Show when={props.settings.mode === "transcription"}>
              <span data-slot="mode-card-badge">{t("vui.mode.active")}</span>
            </Show>
          </div>
          <div data-slot="mode-card-desc">{t("vui.mode.transcription.desc")}</div>
          <div data-slot="mode-card-chord">{describeShortcut(props.settings.transcriptionChord, platform)}</div>
        </div>
      </div>

      {/*
      Sub-choice under agent mode.

      It lives here rather than in a general "audio" section because it
      is the other half of what agent mode *is*: you say something, the
      session answers. Without it the assistant confirms the send and
      goes quiet, and the answer waits on a screen the user may have
      turned away from.
                */}
      <Show when={props.settings.mode === "agent"}>
        <div data-slot="sub-choice-box">
          <span id="agent-reply-label" data-slot="sub-choice-label">
            {t("vui.replies.title")}
          </span>
          <div role="radiogroup" aria-labelledby="agent-reply-label" data-slot="sub-choice-row" onKeyDown={replyKeys}>
            <div
              role="radio"
              data-value="speak"
              aria-checked={props.settings.speakReplies !== false}
              tabIndex={props.settings.speakReplies !== false ? 0 : -1}
              data-slot="sub-choice-item"
              onClick={() => updateSettings({ speakReplies: true })}
            >
              <span data-slot="sub-item-title">{t("vui.replies.speak")}</span>
              <span data-slot="sub-item-desc">{t("vui.replies.speak.desc")}</span>
            </div>

            <div
              role="radio"
              data-value="silent"
              aria-checked={props.settings.speakReplies === false}
              tabIndex={props.settings.speakReplies === false ? 0 : -1}
              data-slot="sub-choice-item"
              onClick={() => updateSettings({ speakReplies: false })}
            >
              <span data-slot="sub-item-title">{t("vui.replies.silent")}</span>
              <span data-slot="sub-item-desc">{t("vui.replies.silent.desc")}</span>
            </div>
          </div>
        </div>

        {/*
        Proactive alerts: nik speaks on its own for permissions, completions, or decisions.
        Off by default to avoid unexpected speech or consumption (S48).
      */}
        <div data-slot="sub-choice-box">
          <span id="agent-alerts-label" data-slot="sub-choice-label">
            {t("vui.alerts.title")}
          </span>
          <div role="radiogroup" aria-labelledby="agent-alerts-label" data-slot="sub-choice-row" onKeyDown={alertsKeys}>
            <div
              role="radio"
              data-value="on"
              aria-checked={props.settings.spokenAlerts === true}
              tabIndex={props.settings.spokenAlerts === true ? 0 : -1}
              data-slot="sub-choice-item"
              onClick={() => updateSettings({ spokenAlerts: true })}
            >
              <span data-slot="sub-item-title">{t("vui.alerts.on")}</span>
              <span data-slot="sub-item-desc">{t("vui.alerts.on.desc")}</span>
            </div>

            <div
              role="radio"
              data-value="off"
              aria-checked={props.settings.spokenAlerts !== true}
              tabIndex={props.settings.spokenAlerts !== true ? 0 : -1}
              data-slot="sub-choice-item"
              onClick={() => updateSettings({ spokenAlerts: false })}
            >
              <span data-slot="sub-item-title">{t("vui.alerts.off")}</span>
              <span data-slot="sub-item-desc">{t("vui.alerts.off.desc")}</span>
            </div>
          </div>
        </div>

        {/*
        What answers what the grammar does not know. A CLI the user is
        signed in to, so it runs on their subscription; see
        `VoiceSettings.agentEngine`.
      */}
        <div data-slot="sub-choice-box">
          <span id="agent-engine-label" data-slot="sub-choice-label">
            {t("vui.engine.title")}
          </span>
          <div role="radiogroup" aria-labelledby="agent-engine-label" data-slot="sub-choice-row" onKeyDown={engineKeys}>
            <For each={AGENT_ENGINE_CHOICES}>
              {(choice) => (
                <div
                  role="radio"
                  data-value={choice.value}
                  aria-checked={props.settings.agentEngine === choice.value}
                  tabIndex={props.settings.agentEngine === choice.value ? 0 : -1}
                  data-slot="sub-choice-item"
                  onClick={() => updateSettings({ agentEngine: choice.value })}
                >
                  <span data-slot="sub-item-title">{choice.title}</span>
                  <span data-slot="sub-item-desc">{choice.desc}</span>
                </div>
              )}
            </For>
          </div>
          {/*
          S13: the agent runs on the user's own subscription, so the
          terms that come with it are said where the engine is chosen.
        */}
          <p data-slot="sub-choice-note">{t("vui.engine.note")}</p>
        </div>

        {/* How the agent thinks: see `VoiceSettings.agentSpeed`. */}
        <Show when={props.settings.agentEngine !== "off"}>
          <div data-slot="sub-choice-box">
            <span id="agent-speed-label" data-slot="sub-choice-label">
              {t("vui.speed.title")}
            </span>
            <div role="radiogroup" aria-labelledby="agent-speed-label" data-slot="sub-choice-row" onKeyDown={speedKeys}>
              <For each={AGENT_SPEED_CHOICES}>
                {(choice) => (
                  <div
                    role="radio"
                    data-value={choice.value}
                    aria-checked={props.settings.agentSpeed === choice.value}
                    tabIndex={props.settings.agentSpeed === choice.value ? 0 : -1}
                    data-slot="sub-choice-item"
                    onClick={() => updateSettings({ agentSpeed: choice.value })}
                  >
                    <span data-slot="sub-item-title">{choice.title}</span>
                    <span data-slot="sub-item-desc">{choice.desc}</span>
                  </div>
                )}
              </For>
            </div>
          </div>
        </Show>

        {/* Ricaduta su Codex al limite di Claude: facoltativa, di default disattivata. */}
        <Show when={props.settings.agentEngine !== "off"}>
          <div data-slot="sub-choice-box">
            <span id="agent-codex-fallback-label" data-slot="sub-choice-label">
              {t("vui.codexFallback.title")}
            </span>
            <div
              role="radiogroup"
              aria-labelledby="agent-codex-fallback-label"
              data-slot="sub-choice-row"
              onKeyDown={fallbackKeys}
            >
              <div
                role="radio"
                data-value="on"
                aria-checked={props.settings.codexFallback === true}
                tabIndex={props.settings.codexFallback === true ? 0 : -1}
                data-slot="sub-choice-item"
                onClick={() => updateSettings({ codexFallback: true })}
              >
                <span data-slot="sub-item-title">{t("vui.codexFallback.on")}</span>
                <span data-slot="sub-item-desc">{t("vui.codexFallback.on.desc")}</span>
              </div>

              <div
                role="radio"
                data-value="off"
                aria-checked={props.settings.codexFallback !== true}
                tabIndex={props.settings.codexFallback !== true ? 0 : -1}
                data-slot="sub-choice-item"
                onClick={() => updateSettings({ codexFallback: false })}
              >
                <span data-slot="sub-item-title">{t("vui.codexFallback.off")}</span>
                <span data-slot="sub-item-desc">{t("vui.codexFallback.off.desc")}</span>
              </div>
            </div>
          </div>
        </Show>
      </Show>

      {/* Sub-choice under transcription */}
      <Show when={props.settings.mode === "transcription"}>
        <div data-slot="sub-choice-box">
          <span id="transcription-send-label" data-slot="sub-choice-label">
            {t("vui.send.title")}
          </span>
          <div
            role="radiogroup"
            aria-labelledby="transcription-send-label"
            data-slot="sub-choice-row"
            onKeyDown={sendKeys}
          >
            <div
              role="radio"
              data-value="manual"
              aria-checked={props.settings.transcriptionSend === "manual"}
              tabIndex={props.settings.transcriptionSend === "manual" ? 0 : -1}
              data-slot="sub-choice-item"
              onClick={() => updateSettings({ transcriptionSend: "manual" })}
            >
              <span data-slot="sub-item-title">{t("vui.send.manual")}</span>
              <span data-slot="sub-item-desc">{t("vui.send.manual.desc")}</span>
            </div>

            <div
              role="radio"
              data-value="auto"
              aria-checked={props.settings.transcriptionSend === "auto"}
              tabIndex={props.settings.transcriptionSend === "auto" ? 0 : -1}
              data-slot="sub-choice-item"
              onClick={() => updateSettings({ transcriptionSend: "auto" })}
            >
              <span data-slot="sub-item-title">{t("vui.send.auto")}</span>
              <span data-slot="sub-item-desc">{t("vui.send.auto.desc")}</span>
            </div>
          </div>
        </div>
      </Show>
    </>
  )
}
