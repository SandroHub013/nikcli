/** Voce › Comandi: the vocabulary, and a field to try a command without speaking. */
import { Show, For, type JSX } from "solid-js"
import { t } from "@nikcli-ai/ade/i18n"
import { VOCABULARY } from "../../intent/vocabulary"
import type { VoiceSettingsState } from "../settings-state"
import { PageHead } from "./head"

export function CommandsPage(p: { state: VoiceSettingsState; bare?: boolean }): JSX.Element {
  const { commandFilter, setCommandFilter, trialText, setTrialText, trialBusy, filteredCommands, runTrial } = p.state
  return (
    <>
      <PageHead
        id="section-commands-title"
        title={t("vui.commands.title")}
        desc={t("vui.commands.desc")}
        bare={p.bare}
      />
      <div data-slot="trial-row">
        <input
          id="voice-trial-input"
          data-slot="input"
          type="text"
          autocomplete="off"
          placeholder={t("vui.commands.trial.placeholder")}
          aria-label={t("vui.commands.trial")}
          value={trialText()}
          disabled={trialBusy()}
          onInput={(e) => setTrialText(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault()
              void runTrial()
            } else if (e.key === "Escape") {
              e.preventDefault()
              e.stopPropagation()
              setTrialText("")
            }
          }}
        />
        <button
          type="button"
          data-slot="solid-btn"
          disabled={trialText().trim().length === 0 || trialBusy()}
          onClick={() => void runTrial()}
        >
          {trialBusy() ? t("vui.commands.sending") : t("vui.commands.run")}
        </button>
      </div>

      <input
        id="voice-command-filter"
        data-slot="input"
        type="search"
        autocomplete="off"
        placeholder={t("vui.commands.filter")}
        aria-label={t("vui.commands.filter.label")}
        aria-describedby="voice-command-count"
        value={commandFilter()}
        onInput={(e) => setCommandFilter(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault()
            e.stopPropagation()
            setCommandFilter("")
          }
        }}
      />

      <div data-slot="command-list">
        <For each={filteredCommands()} fallback={<p data-slot="hint">{t("vui.commands.none")}</p>}>
          {(spec) => (
            <div data-slot="command-row">
              <div data-slot="command-info">
                <span data-slot="command-name">
                  {spec.intent}
                  <Show when={spec.destructive}>
                    <span data-slot="command-flag">{t("vui.commands.confirms")}</span>
                  </Show>
                </span>
                <span data-slot="command-readback">{spec.readback}</span>
              </div>
              <div data-slot="command-phrases">
                <For each={spec.phrases.slice(0, 3)}>
                  {(phrase) => (
                    <button
                      type="button"
                      data-slot="phrase-chip"
                      title={t("vui.commands.usePhrase")}
                      onClick={() => {
                        setTrialText(phrase)
                        document.getElementById("voice-trial-input")?.focus()
                      }}
                    >
                      {phrase}
                    </button>
                  )}
                </For>
              </div>
            </div>
          )}
        </For>
      </div>
      <p id="voice-command-count" data-slot="hint">
        {t("vui.commands.count", filteredCommands().length, VOCABULARY.length)}
      </p>
    </>
  )
}
