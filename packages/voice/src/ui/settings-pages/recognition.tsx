/** Voce › Riconoscimento: how speech becomes text, and the key it spends. */
import { Show, type JSX } from "solid-js"
import { t } from "@nikcli-ai/ade/i18n"
import { formatMaskedApiKey } from "../shortcut-capture"
import type { VoiceSettingsState } from "../settings-state"
import { PageHead } from "./head"

export function RecognitionPage(p: { state: VoiceSettingsState; bare?: boolean }): JSX.Element {
  const {
    props,
    apiKeyInput,
    setApiKeyInput,
    apiKeyVisible,
    setApiKeyVisible,
    backendStatuses,
    resolvedCost,
    updateSettings,
    commitApiKey,
    apiKeyLooksWrong,
    backendKeys,
  } = p.state
  return (
    <>
      <PageHead id="section-backend-title" title={t("vui.backend.title")} desc={t("vui.backend.desc")} bare={p.bare} />
      <div role="radiogroup" aria-labelledby="section-backend-title" data-slot="backend-list" onKeyDown={backendKeys}>
        {/* OpenRouter Cloud */}
        <div
          data-slot="backend-card"
          data-checked={props.settings.backend === "openrouter" ? "true" : undefined}
          data-unusable={!backendStatuses().openrouter.usable ? "true" : undefined}
        >
          <div
            data-slot="backend-header"
            role="radio"
            data-value="openrouter"
            tabIndex={props.settings.backend === "openrouter" ? 0 : -1}
            aria-checked={props.settings.backend === "openrouter"}
            aria-describedby={!backendStatuses().openrouter.usable ? "backend-openrouter-reason" : undefined}
            onClick={() => updateSettings({ backend: "openrouter" })}
          >
            <div data-slot="item-text-group">
              <span data-slot="item-title">OpenRouter</span>
              <span data-slot="item-desc">{t("vui.backend.openrouter.desc")}</span>
            </div>
            <span data-slot="ready-tag" data-ready={backendStatuses().openrouter.usable ? "true" : "false"}>
              {backendStatuses().openrouter.usable ? t("vui.backend.ready") : t("vui.backend.needsKey")}
            </span>
          </div>

          {/* OpenRouter status message if key missing */}
          <Show when={!backendStatuses().openrouter.usable}>
            <div id="backend-openrouter-reason" data-slot="reason-box" data-tone="muted">
              {backendStatuses().openrouter.reason}
            </div>
          </Show>

          {/* Sub-fields under OpenRouter */}
          <Show when={props.settings.backend === "openrouter"}>
            <div data-slot="backend-subfields">
              <div data-slot="stack">
                <label for="openrouter-key-field" data-slot="label">
                  {t("vui.key.title")}
                </label>

                {/* Masked display when key already saved */}
                <Show when={Boolean(props.settings.openRouterApiKey)}>
                  <div data-slot="key-status-badge">
                    <span>{t("vui.key.saved", formatMaskedApiKey(props.settings.openRouterApiKey))}</span>
                    <button
                      type="button"
                      data-slot="key-clear-btn"
                      onClick={() => updateSettings({ openRouterApiKey: undefined })}
                    >
                      {t("vui.key.remove")}
                    </button>
                  </div>
                </Show>

                {/* Input for setting or updating key */}
                <div data-slot="field-row">
                  <input
                    id="openrouter-key-field"
                    data-slot="input"
                    type={apiKeyVisible() ? "text" : "password"}
                    autocomplete="off"
                    spellcheck={false}
                    placeholder={props.settings.openRouterApiKey ? t("vui.key.replace") : "sk-or-v1-…"}
                    value={apiKeyInput()}
                    aria-describedby="openrouter-key-hint"
                    onInput={(e) => setApiKeyInput(e.currentTarget.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault()
                        commitApiKey()
                      } else if (e.key === "Escape") {
                        e.preventDefault()
                        e.stopPropagation()
                        setApiKeyInput("")
                      }
                    }}
                    onBlur={commitApiKey}
                  />
                  <button
                    type="button"
                    data-slot="ghost-btn"
                    aria-pressed={apiKeyVisible()}
                    disabled={apiKeyInput().length === 0}
                    onClick={() => setApiKeyVisible((v) => !v)}
                  >
                    {apiKeyVisible() ? t("vui.key.hide") : t("vui.key.show")}
                  </button>
                  <button
                    type="button"
                    data-slot="solid-btn"
                    disabled={apiKeyInput().trim().length === 0}
                    onClick={commitApiKey}
                  >
                    {t("vui.key.save")}
                  </button>
                </div>

                <Show when={apiKeyLooksWrong()}>
                  <div data-slot="reason-box" data-tone="muted">
                    {t("vui.key.looksWrong")}
                  </div>
                </Show>

                <p id="openrouter-key-hint" data-slot="hint">
                  {t("vui.key.hint")}
                </p>
              </div>

              {/* Cost of the last request if exposed */}
              <Show when={resolvedCost() !== undefined}>
                <div data-slot="cost-tag">
                  {t("vui.key.cost")}{" "}
                  <strong>${resolvedCost()! < 0.01 ? resolvedCost()!.toFixed(5) : resolvedCost()!.toFixed(3)}</strong>
                </div>
              </Show>
            </div>
          </Show>
        </div>
      </div>
    </>
  )
}
