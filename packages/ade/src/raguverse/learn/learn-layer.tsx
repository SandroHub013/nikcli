import { Show, createSignal, onMount } from "solid-js"
import { EXPORT_NAME, parseProgress } from "./progress"
import { LearnFrame, type LearnFrameApi, type LearnOpening, type LearnProgressHost } from "./learn-frame"
import "./learn-layer.css"
import { t } from "../../i18n"

/**
 * The lesson page with its bar: «Torna al mondo», «Esporta progressi», «Importa progressi».
 *
 * The bar is ADE's own DOM, never the frame's: the file for the import is chosen here, a page cannot be trusted to ask about itself.
 * In RaguVerse the whole thing is a layer over the world (`raguverse-pane.tsx`); where there is no world to go back to, `onBack` is absent
 * and so is the first button.
 */
export function LearnLayer(props: {
  place: LearnOpening
  /** ADE's commands for the progress; absent where there is no host, and then the layer only shows the page. */
  progress?: () => Promise<LearnProgressHost | undefined>
  /** A message the page sent that ADE ignored, and why. */
  onIgnored?: (reason: string) => void
  /** The way back to the world: the button, Esc on the bar and Esc in the page all end here. */
  onBack?: () => void
  autofocus?: boolean
}) {
  let file: HTMLInputElement | undefined
  let frame: LearnFrameApi | undefined
  const [notice, setNotice] = createSignal<string | undefined>()
  /** The host, when there is one: a browser without it can show the page but cannot keep the progress. */
  const host = async () => (await props.progress?.()) ?? undefined
  /** Whether there is one, read once at mounting: without it the two progress buttons are out, not silently doing nothing. */
  const [hasHost, setHasHost] = createSignal(false)
  onMount(() => void host().then((h) => setHasHost(Boolean(h))))

  const exportProgress = async () => {
    const commands = await host()
    if (!commands) return setNotice(t("learn.noHost"))
    try {
      const parsed = parseProgress(await commands.load())
      if (!parsed.ok) return setNotice(t("learn.progressUnreadable"))
      const blob = new Blob([JSON.stringify(parsed.progress, null, 2)], { type: "application/json" })
      const url = URL.createObjectURL(blob)
      const link = document.createElement("a")
      link.href = url
      link.download = EXPORT_NAME
      link.click()
      URL.revokeObjectURL(url)
      setNotice(t("learn.exported"))
    } catch (error) {
      setNotice(t("learn.exportFailed", String((error as Error)?.message ?? error).slice(0, 80)))
    }
  }

  const importProgress = async (chosen: File | undefined) => {
    const commands = await host()
    if (!chosen || !commands) return
    let json: string
    try {
      const parsed = parseProgress(JSON.parse(await chosen.text()))
      if (!parsed.ok) return setNotice(t("learn.importRefused", parsed.reason))
      json = JSON.stringify(parsed.progress)
    } catch (error) {
      return setNotice(t("learn.importFailed", String((error as Error)?.message ?? error).slice(0, 80)))
    }
    try {
      // The old page's door shuts before the file is written, and the writes it already started finish first: an answer given a moment
      // ago must not land on top of the progress that was just imported.
      await frame?.retire()
      await commands.save(json)
      setNotice(t("learn.imported"))
    } catch (error) {
      setNotice(t("learn.importFailed", String((error as Error)?.message ?? error).slice(0, 80)))
    }
    // The page reads the progress when it opens, so an import is handed to it by opening the page again, whether or not it was written.
    frame?.reload()
  }

  return (
    <div data-component="learn-layer">
      <div
        data-slot="learn-progress"
        onKeyDown={(event) => {
          // Esc on the bar is ADE's: the page never sees it.
          if (event.key === "Escape" && props.onBack) {
            event.preventDefault()
            props.onBack()
          }
        }}
      >
        <Show when={props.onBack}>
          <button type="button" data-slot="learn-back" onClick={() => props.onBack?.()}>
            {t("learn.back")}
          </button>
        </Show>
        <button type="button" data-slot="learn-export" onClick={() => void exportProgress()} disabled={!hasHost()}>
          {t("learn.export")}
        </button>
        <button type="button" data-slot="learn-import" onClick={() => file?.click()} disabled={!hasHost()}>
          {t("learn.import")}
        </button>
        <Show when={notice()}>
          {(text) => (
            <span data-slot="learn-notice" role="status">
              {text()}
            </span>
          )}
        </Show>
        {/* The file is chosen in ADE's own DOM, never in the frame: a page cannot be trusted to ask about itself. */}
        <input
          ref={file}
          type="file"
          accept="application/json,.json"
          data-slot="learn-file"
          hidden
          onChange={(event) => {
            const chosen = event.currentTarget.files?.[0]
            event.currentTarget.value = ""
            void importProgress(chosen)
          }}
        />
      </div>
      <LearnFrame
        place={props.place}
        progress={props.progress}
        onIgnored={props.onIgnored}
        onUnreadable={() => setNotice(t("learn.progressUnreadable"))}
        onClose={props.onBack}
        autofocus={props.autofocus}
        api={(api) => (frame = api)}
      />
    </div>
  )
}
