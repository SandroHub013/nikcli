import { Show } from "solid-js"
import { t } from "@nikcli-ai/ade/i18n"
import type { PackView } from "../settings/voice-pack"

/**
 * An install under way, with the bar and the cancel (K3's progress, given a
 * reader at last). Shared by the Piper download and the Kokoro pack.
 */
export function InstallBar(props: { view: PackView; onCancel?: () => void }) {
  return (
    <div data-slot="progress-box">
      <div data-slot="progress-meta">
        <span>{t("vui.pack.installing")}</span>
        <span>
          {props.view.bytesTotal
            ? t("vui.pack.bytesOf", props.view.bytesDone ?? "0 MB", props.view.bytesTotal, String(props.view.percent ?? 0))
            : props.view.filesTotal
              ? t("vui.pack.filesOf", props.view.bytesDone ?? "0 MB", String(props.view.filesDone ?? 0), String(props.view.filesTotal))
              : (props.view.bytesDone ?? "")}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={t("vui.pack.installing")}
        aria-valuenow={props.view.percent ?? 0}
        aria-valuemin="0"
        aria-valuemax="100"
        data-slot="progressbar-track"
      >
        <div data-slot="progressbar-fill" style={{ width: `${props.view.percent ?? 0}%` }} />
      </div>
      <Show when={props.onCancel}>
        <button
          type="button"
          data-slot="ghost-btn"
          disabled={!props.view.canCancel}
          onClick={() => props.onCancel?.()}
        >
          {props.view.canCancel ? t("vui.pack.cancel") : t("vui.pack.cancelling")}
        </button>
      </Show>
    </div>
  )
}

/**
 * The Kokoro pack in the reply-voice box (K6): whether this ADE can run it,
 * the install with its size, the progress and its cancel, the delete, and
 * where the model and the program that reads it come from, with their
 * licences. What is shown is `packView`'s, not decided here.
 */
export function VoicePackBox(props: {
  view: PackView
  onInstall?: () => void
  onCancel?: () => void
  onDelete?: () => void
}) {
  const view = () => props.view
  return (
    <div data-slot="voice-pack" data-phase={view().phase}>
      <p data-slot="sub-choice-note">
        <Show when={view().phase === "unavailable"}>{t("vui.pack.kokoro.unavailable")}</Show>
        <Show when={view().phase === "absent"}>{t("vui.pack.kokoro.absent")}</Show>
        <Show when={view().phase === "installed"}>{t("vui.pack.kokoro.installed")}</Show>
      </p>

      <Show when={view().phase === "installing"}>
        <InstallBar view={view()} {...(props.onCancel ? { onCancel: props.onCancel } : {})} />
      </Show>

      <Show when={view().canInstall && props.onInstall}>
        <button type="button" data-slot="ghost-btn" onClick={() => props.onInstall?.()}>
          {view().size ? t("vui.pack.installSize", view().size ?? "") : t("vui.pack.install")}
        </button>
      </Show>
      <Show when={view().phase === "installed" && view().removable && props.onDelete}>
        <button type="button" data-slot="ghost-btn" disabled={!view().canDelete} onClick={() => props.onDelete?.()}>
          {view().canDelete ? t("vui.pack.delete") : t("vui.pack.deleting")}
        </button>
      </Show>

      <Show when={view().error}>
        <div data-slot="reply-voice-error" role="alert">
          <span>{view().error}</span>
        </div>
      </Show>

      <p data-slot="sub-choice-note">
        {t("vui.pack.kokoro.model")} {t("vui.pack.kokoro.host")}
      </p>
    </div>
  )
}
