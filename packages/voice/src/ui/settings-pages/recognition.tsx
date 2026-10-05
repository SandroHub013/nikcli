/** Voce › Riconoscimento: how speech becomes text, and the key it spends. */
import { Show, type JSX } from "solid-js"
import { t } from "@nikcli-ai/ade/i18n"
import { formatMaskedApiKey } from "../shortcut-capture"
import type { VoiceSettingsState } from "../settings-state"
import { PageHead } from "./head"

export function RecognitionPage(p: { state: VoiceSettingsState; bare?: boolean }): JSX.Element {
  const { props, backendStatuses, resolvedCost, updateSettings, backendKeys } = p.state
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
              {/*
               * The key is not typed here any more: it is an entry of the
               * system keychain, on ADE's Chiavi API page, the one place for
               * keys. This says whether there is one and where it is managed.
               */}
              <div data-slot="stack" data-key-status>
                <span data-slot="label">{t("vui.key.title")}</span>
                <div data-slot="key-status-badge">
                  <span>
                    {props.settings.openRouterApiKey
                      ? t("vui.key.saved", formatMaskedApiKey(props.settings.openRouterApiKey))
                      : t("vui.key.none")}
                  </span>
                  <Show when={props.onManageKeys}>
                    <button
                      type="button"
                      data-slot="link-button"
                      data-manage-keys=""
                      onClick={() => props.onManageKeys?.()}
                    >
                      {t("vui.key.manage")}
                    </button>
                  </Show>
                </div>
                <p data-slot="hint">{t("vui.key.where")}</p>
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
