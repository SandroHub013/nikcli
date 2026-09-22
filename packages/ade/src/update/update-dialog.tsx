import { createEffect, on, onCleanup, onMount, Show } from "solid-js"
import { Overlay, Surface } from "../ui/layout"
import { locale, t } from "../i18n"
import { nextFocusIndex, updateDialogView } from "./dialog-state"
import { formatMb, progressPercent, type UpdateProgress } from "./progress"

/**
 * The question ADE asks before updating itself (S71), drawn in the window.
 *
 * It used to be the platform's message box: always light, a yellow triangle,
 * and «Aggiorna e riavvia» as the default button, so a stray Enter closed
 * every running session. Here the focus starts on «Più tardi», Esc and the
 * scrim refuse, and only Enter on the filled button updates. The download and
 * the hand-over to the installer are shown in the same panel, so the window
 * does not go silent between the click and its own closing; while they run
 * the ghost button says «Nascondi» and puts the panel away, the bell's bar
 * keeps reporting. A failure is shown here too, with the release page one
 * link away.
 *
 * The focus never leaves the panel: Tab wraps over what can be pressed, and
 * when nothing can be (a stage change disabled the button that had it) the
 * panel itself takes it, so the person is never left behind a modal they
 * cannot reach with the keyboard.
 */
export function UpdateDialog(props: {
  readonly fromVersion: string | undefined
  readonly toVersion: string
  readonly releaseUrl: string
  readonly running: number
  readonly updating: boolean
  readonly progress: UpdateProgress | undefined
  readonly error: string | undefined
  readonly onLater: () => void
  readonly onGo: () => void
  readonly onOpenRelease: () => void
}) {
  const view = () => updateDialogView({ updating: props.updating, progress: props.progress, error: props.error })
  const refuse = () => {
    if (view().dismissable) props.onLater()
  }
  let surface: HTMLDivElement | undefined
  const stops = () => Array.from(surface?.querySelectorAll<HTMLElement>("button:not(:disabled), a[href]") ?? [])

  // The focus goes back where it came from: the bell's «Aggiorna» button.
  const opener = typeof document !== "undefined" ? (document.activeElement as HTMLElement | null) : null
  const keepFocusInside = () => {
    if (!surface || surface.contains(document.activeElement)) return
    ;(surface.querySelector<HTMLElement>('[data-slot="decision-ghost"]:not(:disabled)') ?? stops()[0] ?? surface).focus()
  }
  onMount(() => {
    queueMicrotask(() => surface?.querySelector<HTMLElement>('[data-slot="decision-ghost"]')?.focus())
  })
  // A button that goes disabled drops the focus on the body; pick it up again.
  createEffect(on(() => view().stage, () => queueMicrotask(keepFocusInside), { defer: true }))
  onCleanup(() => {
    if (opener?.isConnected) opener.focus()
  })

  const megabytes = (bytes: number) => formatMb(bytes, locale())
  const body = () => {
    const progress = props.progress
    switch (view().stage) {
      case "download":
        return progress?.phase === "download"
          ? t("update.downloading", megabytes(progress.downloaded), progress.total ? megabytes(progress.total) : null)
          : t("update.dialog.starting")
      case "install":
        return t("update.installing")
      case "error":
        return t("update.dialog.failed")
      default:
        return props.running > 0 ? t("update.restart", props.running) : t("update.restart.none")
    }
  }
  const percent = () => progressPercent(props.progress)

  return (
    <Overlay
      data-component="update-dialog"
      place="center"
      onClose={refuse}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault()
          refuse()
          return
        }
        if (event.key !== "Tab") return
        event.preventDefault()
        const list = stops()
        const next = nextFocusIndex(list.indexOf(document.activeElement as HTMLElement), list.length, event.shiftKey)
        ;(next < 0 ? surface : list[next])?.focus()
      }}
    >
      <Surface
        ref={(el) => (surface = el)}
        size="sm"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="update-dialog-title"
        aria-describedby="update-dialog-body"
        data-stage={view().stage}
        tabindex={-1}
      >
        <header data-slot="sheet-head">
          <span data-slot="update-dialog-mark" aria-hidden="true">
            <svg viewBox="0 0 16 16" width="20" height="20">
              <path d="M3.2 13.2V2.8h1.9l5.7 7.2V2.8h1.9v10.4h-1.9L5.1 6v7.2Z" fill="currentColor" />
            </svg>
          </span>
          <strong id="update-dialog-title">{t("update.restart.title")}</strong>
          <span data-slot="update-dialog-version">
            <Show when={props.fromVersion}>{(from) => <>{from()} → </>}</Show>
            <b>{props.toVersion}</b>
          </span>
        </header>
        <div data-slot="update-dialog-body">
          <p id="update-dialog-body">{body()}</p>
          <Show when={view().stage === "error" && props.error}>
            {(problem) => <code data-slot="update-dialog-problem">{problem()}</code>}
          </Show>
          <Show when={view().stage === "download" || view().stage === "install"}>
            <span
              data-slot="update-dialog-progress"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent()}
              aria-label={body()}
            >
              <span data-slot="update-dialog-track">
                <span
                  data-slot="update-dialog-fill"
                  data-indeterminate={percent() === undefined ? "true" : undefined}
                  style={{ width: `${percent() ?? 100}%` }}
                />
              </span>
            </span>
          </Show>
          <Show when={view().stage === "ask" || view().stage === "error"}>
            <a
              data-slot="update-dialog-link"
              href={props.releaseUrl}
              onClick={(event) => {
                event.preventDefault()
                props.onOpenRelease()
              }}
            >
              {view().stage === "error" ? t("update.dialog.openRelease") : t("update.dialog.notes", props.toVersion)}
            </a>
          </Show>
        </div>
        <footer data-slot="update-dialog-actions">
          <Show when={view().stage === "ask"}>
            <span data-slot="update-dialog-hint">
              <kbd>{t("update.dialog.escKey")}</kbd> {t("update.restart.later").toLocaleLowerCase(locale())}
            </span>
          </Show>
          <button type="button" data-slot="decision-ghost" disabled={!view().ghost.enabled} onClick={refuse}>
            {view().ghost.label === "close"
              ? t("update.dialog.close")
              : view().ghost.label === "hide"
                ? t("update.dialog.hide")
                : t("update.restart.later")}
          </button>
          <button type="button" data-slot="decision-submit" disabled={!view().submit.enabled} onClick={props.onGo}>
            {view().submit.label === "retry" ? t("update.dialog.retry") : t("update.restart.ok")}
          </button>
        </footer>
      </Surface>
    </Overlay>
  )
}
