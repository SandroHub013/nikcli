/**
 * Voce › Voce delle risposte: who reads the agent's answers — Piper, Kokoro,
 * MAI or the system — and, for MAI, its question, state, spend and «Riprova».
 */
import { Show, For, type JSX } from "solid-js"
import { locale, t } from "@nikcli-ai/ade/i18n"
import {
  REPLY_BACKEND_CHOICES,
  replyVoiceChoicesFor,
  voiceOnBackend,
  isMaiVoice,
  localReplyVoice,
  MAI_VOICE_CHOICES,
} from "../../settings/reply-voices"
import { maiOfferShown, maiRetryShown, maiSpendText, maiStatusText } from "../mai-panel"
import { InstallBar, VoicePackBox } from "../voice-pack-box"
import type { VoiceSettingsState } from "../settings-state"
import { PageHead } from "./head"

export function ReplyPage(p: { state: VoiceSettingsState; bare?: boolean }): JSX.Element {
  const {
    props,
    pickReplyVoice,
    replyVoiceKeys,
    replyBackendKeys,
    replyBackendNow,
    maiInput,
    acceptMaiOffer,
    declineMaiOffer,
    pickMaiLocal,
    shownReplyVoice,
    kokoroView,
    piperDownload,
    canTestVoice,
  } = p.state
  return (
    <>
      <PageHead id="section-reply-title" title={t("vui.reply.title")} desc={t("vui.reply.desc")} bare={p.bare} />
      <div data-slot="sub-choice-box">
        <span id="reply-backend-label" data-slot="sub-choice-label">
          {t("vui.replies.backend")}
        </span>
        <div
          role="radiogroup"
          aria-labelledby="reply-backend-label"
          data-slot="sub-choice-row"
          onKeyDown={replyBackendKeys}
        >
          <For each={REPLY_BACKEND_CHOICES}>
            {(choice) => (
              <div
                role="radio"
                data-value={choice.value}
                aria-checked={replyBackendNow() === choice.value}
                tabIndex={replyBackendNow() === choice.value ? 0 : -1}
                data-slot="sub-choice-item"
                onClick={() => pickReplyVoice(voiceOnBackend(choice.value, props.settings.replyVoice, locale()))}
              >
                <span data-slot="sub-item-title">{choice.title}</span>
                <span data-slot="sub-item-desc">{choice.desc}</span>
              </div>
            )}
          </For>
        </div>
        <span id="reply-voice-label" data-slot="sub-choice-label">
          {t("vui.replies.voice")}
        </span>
        <div
          role="radiogroup"
          aria-labelledby="reply-voice-label"
          data-slot="sub-choice-row"
          onKeyDown={replyVoiceKeys}
        >
          <For each={replyVoiceChoicesFor(replyBackendNow(), locale())}>
            {(choice) => (
              <div
                role="radio"
                data-value={choice.value}
                aria-checked={shownReplyVoice() === choice.value}
                tabIndex={shownReplyVoice() === choice.value ? 0 : -1}
                data-slot="sub-choice-item"
                onClick={() => pickReplyVoice(choice.value)}
              >
                <span data-slot="sub-item-title">{choice.title}</span>
                <span data-slot="sub-item-desc">{choice.desc}</span>
                <Show when={choice.licence}>
                  <span data-slot="sub-item-licence">
                    {choice.licence}{" "}
                    {/* The host opens the page of a Piper voice only; Kokoro's source is in its pack's note. */}
                    <Show when={props.onOpenVoiceSource && replyBackendNow() !== "kokoro"}>
                      <button
                        type="button"
                        data-slot="link-button"
                        onClick={(event) => {
                          // The link sits inside the radio: opening the source must not also pick the voice.
                          event.stopPropagation()
                          props.onOpenVoiceSource?.(choice.value)
                        }}
                      >
                        {t("vui.replies.source")}
                      </button>
                    </Show>
                  </span>
                </Show>
              </div>
            )}
          </For>
        </div>
        <Show when={replyBackendNow() === "piper"}>
          <p data-slot="sub-choice-note">{t("vui.replies.note")}</p>
          <Show when={props.naturalVoiceDownloading && piperDownload()}>
            {(view) => (
              <InstallBar
                view={view()}
                {...(props.onCancelInstall ? { onCancel: () => props.onCancelInstall?.("piper") } : {})}
              />
            )}
          </Show>
        </Show>
        <Show when={replyBackendNow() === "kokoro"}>
          <p data-slot="sub-choice-note">{t("vui.replies.kokoroItalian")}</p>
          <VoicePackBox
            view={kokoroView()}
            {...(props.onInstallKokoro ? { onInstall: props.onInstallKokoro } : {})}
            {...(props.onCancelInstall ? { onCancel: () => props.onCancelInstall?.("kokoro") } : {})}
            {...(props.onDeleteKokoro ? { onDelete: props.onDeleteKokoro } : {})}
          />
        </Show>
        <Show when={props.onTestVoice}>
          <button type="button" data-slot="ghost-btn" disabled={!canTestVoice()} onClick={() => props.onTestVoice?.()}>
            {t("vui.replies.test")}
          </button>
        </Show>
        <Show when={props.naturalVoiceError}>
          <div data-slot="reply-voice-error" role="alert">
            <span>{props.naturalVoiceError}</span>
            <Show when={props.onDownloadNaturalVoice}>
              <button
                type="button"
                data-slot="link-button"
                disabled={props.naturalVoiceDownloading}
                onClick={() => props.onDownloadNaturalVoice?.()}
              >
                {props.naturalVoiceDownloading ? t("vui.replies.downloading") : t("vui.replies.retry")}
              </button>
            </Show>
          </div>
        </Show>
      </div>

      {/* The reply voice on MAI: here, because it is the OpenRouter key above that it spends. */}
      <div data-slot="sub-choice-box" data-component="mai-box">
        <span id="mai-title" data-slot="sub-choice-label">
          {t("vui.mai.title")}
        </span>
        <p data-slot="sub-choice-note" data-mai="status">
          {maiStatusText(maiInput())}
        </p>
        <Show when={maiOfferShown(maiInput())}>
          <div data-slot="reason-box" data-tone="muted" role="group" aria-label={t("vui.mai.offer")}>
            <span>{t("vui.mai.offer")}</span>{" "}
            <button type="button" data-slot="solid-btn" data-mai-offer="use" onClick={acceptMaiOffer}>
              {t("vui.mai.offer.use")}
            </button>{" "}
            <button type="button" data-slot="ghost-btn" data-mai-offer="keep" onClick={declineMaiOffer}>
              {t("vui.mai.offer.keep")}
            </button>
          </div>
        </Show>
        <Show when={!props.testIdentity}>
          <label for="mai-voice-select" data-slot="label">
            {t("vui.mai.voice")}
          </label>
          <select
            id="mai-voice-select"
            data-slot="select"
            value={isMaiVoice(props.settings.replyVoice) ? props.settings.replyVoice : ""}
            onChange={(event) => {
              const choice = MAI_VOICE_CHOICES.find((voice) => voice.value === event.currentTarget.value)
              if (choice) pickReplyVoice(choice.value)
            }}
          >
            <Show when={!isMaiVoice(props.settings.replyVoice)}>
              <option value="">—</option>
            </Show>
            <For each={MAI_VOICE_CHOICES}>{(choice) => <option value={choice.value}>{choice.title}</option>}</For>
          </select>
          <label for="mai-local-select" data-slot="label">
            {t("vui.mai.local")}
          </label>
          <select
            id="mai-local-select"
            data-slot="select"
            value={localReplyVoice(props.settings)}
            onChange={(event) => {
              const choice = replyVoiceChoicesFor("piper", "it").find(
                (voice) => voice.value === event.currentTarget.value,
              )
              if (choice) pickMaiLocal(choice.value)
            }}
          >
            <For each={replyVoiceChoicesFor("piper", "it")}>
              {(choice) => <option value={choice.value}>{choice.title}</option>}
            </For>
          </select>
          <p data-slot="cost-tag">{maiSpendText(props.engine.listenSpend(), locale())}</p>
          <Show when={props.onRetryMai && maiRetryShown(maiInput())}>
            <button type="button" data-slot="ghost-btn" data-mai-retry="" onClick={() => props.onRetryMai?.()}>
              {t("vui.mai.retry")}
            </button>
          </Show>
        </Show>
      </div>
    </>
  )
}
