/** Voce › Riconoscimento: how speech becomes text, and the keys it spends. */
import { Show, type JSX } from "solid-js"
import { t } from "@nikcli-ai/ade/i18n"
import { STREAM_DAILY_CAP_MAX_USD } from "../../settings/model"
import { HowItWorks } from "../how-it-works"
import { formatMaskedApiKey } from "../shortcut-capture"
import type { VoiceSettingsState } from "../settings-state"
import { otherSpendText, streamRetryShown, streamSpendText, streamStatusText } from "../stream-panel"
import { PageHead } from "./head"

export function RecognitionPage(p: { state: VoiceSettingsState; bare?: boolean }): JSX.Element {
  const { props, backendStatuses, resolvedCost, updateSettings, backendKeys, streamInput } = p.state
  const streaming = () => props.settings.backend === "grok-stream"
  /** The cap as typed: a number in range is saved, anything else puts the saved one back. */
  const commitCap = (input: HTMLInputElement) => {
    const value = Number(input.value.replace(",", "."))
    if (input.value.trim() === "" || !Number.isFinite(value)) {
      input.value = String(props.settings.streamDailyCapUsd)
      return
    }
    const cap = Math.min(STREAM_DAILY_CAP_MAX_USD, Math.max(0, value))
    input.value = String(cap)
    if (cap !== props.settings.streamDailyCapUsd) updateSettings({ streamDailyCapUsd: cap })
  }
  return (
    <>
      <PageHead id="section-backend-title" title={t("vui.backend.title")} desc={t("vui.backend.desc")} bare={p.bare} />
      <div role="radiogroup" aria-labelledby="section-backend-title" data-slot="backend-list" onKeyDown={backendKeys}>
        {/* Grok streaming, the default: MAI-Transcribe-2 takes every sentence it cannot write. */}
        <div
          data-slot="backend-card"
          data-checked={streaming() ? "true" : undefined}
          data-unusable={!backendStatuses().grokStream.usable ? "true" : undefined}
        >
          <div
            data-slot="backend-header"
            role="radio"
            data-value="grok-stream"
            tabIndex={streaming() ? 0 : -1}
            aria-checked={streaming()}
            onClick={() => updateSettings({ backend: "grok-stream" })}
          >
            <div data-slot="item-text-group">
              <span data-slot="item-title">{t("vui.backend.grok")}</span>
              <span data-slot="item-desc">{t("vui.backend.grok.desc")}</span>
            </div>
            <span data-slot="ready-tag" data-ready={backendStatuses().grokStream.usable ? "true" : "false"}>
              {backendStatuses().grokStream.usable ? t("vui.backend.ready") : t("vui.backend.needsKey")}
            </span>
          </div>
        </div>

        {/* MAI-Transcribe-2 on OpenRouter, a sentence at a time */}
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
            onClick={() => updateSettings({ backend: "openrouter" })}
          >
            <div data-slot="item-text-group">
              <span data-slot="item-title">{t("vui.backend.mai2")}</span>
              <span data-slot="item-desc">{t("vui.backend.openrouter.desc")}</span>
            </div>
            <span data-slot="ready-tag" data-ready={backendStatuses().openrouter.usable ? "true" : "false"}>
              {backendStatuses().openrouter.usable ? t("vui.backend.ready") : t("vui.backend.needsKey")}
            </span>
          </div>

          {/* Cost of the last request if exposed */}
          <Show when={props.settings.backend === "openrouter" && resolvedCost() !== undefined}>
            <div data-slot="backend-subfields">
              <div data-slot="cost-tag">
                {t("vui.key.cost")}{" "}
                <strong>${resolvedCost()! < 0.01 ? resolvedCost()!.toFixed(5) : resolvedCost()!.toFixed(3)}</strong>
              </div>
            </div>
          </Show>
        </div>
      </div>

      {/* Which engine writes the sentences now, and why when it is not the chosen one (`stream-panel.ts`). */}
      <div data-slot="stack" data-stream-status>
        <p data-slot="sub-choice-note" role="status" data-stream="status">
          {streamStatusText(streamInput())}
        </p>
        <Show when={props.onRetryStream && streamRetryShown(streamInput())}>
          <button type="button" data-slot="ghost-btn" data-stream-retry="" onClick={() => props.onRetryStream?.()}>
            {t("vui.stream.retry")}
          </button>
        </Show>
      </div>

      <Show when={streaming() && !props.testIdentity}>
        <div data-slot="stack" data-stream-cap>
          <label for="voice-stream-cap" data-slot="label">
            {t("vui.stream.cap")}
          </label>
          <input
            id="voice-stream-cap"
            data-slot="input"
            type="number"
            min="0"
            max={String(STREAM_DAILY_CAP_MAX_USD)}
            step="0.05"
            inputmode="decimal"
            aria-describedby="voice-stream-cap-hint"
            value={String(props.settings.streamDailyCapUsd)}
            onChange={(event) => commitCap(event.currentTarget)}
          />
          <p id="voice-stream-cap-hint" data-slot="hint">
            {t("vui.stream.cap.hint")}
          </p>
        </div>
      </Show>

      {/* The day's spending: the stream against its cap, and OpenRouter's apart. */}
      <div data-slot="stack" data-stream-spend>
        <p data-slot="cost-tag" data-stream="spend">
          {streamSpendText(streamInput())}
        </p>
        <p data-slot="cost-tag" data-stream="spend-other">
          {otherSpendText(streamInput().spend, streamInput().language)}
        </p>
      </div>

      {/*
       * The key is not typed here any more: it is an entry of the
       * system keychain, on ADE's Chiavi API page, the one place for
       * keys. This says whether there is one and where it is managed.
       * Shown whatever recognises speech: Grok streaming is the default, but
       * the batch fallback and MAI's replies spend this key, and without it
       * the voice does not start.
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
            <button type="button" data-slot="link-button" data-manage-keys="" onClick={() => props.onManageKeys?.()}>
              {t("vui.key.manage")}
            </button>
          </Show>
        </div>
        <Show when={!props.settings.openRouterApiKey}>
          <p data-slot="reason-box" data-tone="muted" data-needs-openrouter="">
            {t("vui.stream.needsOpenRouter")}
          </p>
        </Show>
        <p data-slot="hint">{t("vui.key.where")}</p>
      </div>

      <HowItWorks title={t("settings.howItWorks")}>
        <p data-slot="hint">{t("vui.stream.how")}</p>
      </HowItWorks>
    </>
  )
}
