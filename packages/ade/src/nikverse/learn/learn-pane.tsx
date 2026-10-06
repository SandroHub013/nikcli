import { Show, batch, createSignal, onCleanup, onMount } from "solid-js"
import { createHandshake, newNonce } from "../handshake"
import { PORT_OFFER, PROTOCOL_VERSION, worldUrl } from "../protocol"
import { EXPORT_NAME, parseProgress } from "./progress"
import { createLearnLink } from "./link"
import "./learn-pane.css"
import { t } from "../../i18n"

/**
 * The «Impara» panel: the lesson page in a frame, and ADE's end of the channel.
 *
 * It is the world's own arrangement — an origin of its own, a nonce in the address, one `MessageChannel` port and nothing else on it —
 * with everything the world needs and this does not: no snapshot of the workbench, no commands, no chords, no GPU. Which is why it opens
 * and works with NikVerse switched off, and on a machine with no WebGPU: what is inside the frame is text and a few buttons.
 *
 * What it decides is in `link.ts` and `progress.ts`; this is the wiring.
 */

export interface LearnProgressHost {
  /** The progress as it is on disk. */
  load: () => Promise<unknown>
  /** Replaces it. The value has already been checked against the shape. */
  save: (json: string) => Promise<void>
}

export function LearnPane(props: {
  focused: boolean
  /** ADE's commands for the progress; absent where there is no host, and then the panel only shows the page. */
  progress?: () => Promise<LearnProgressHost | undefined>
  /** A message the page sent that ADE ignored, and why. */
  onIgnored?: (reason: string) => void
  onFocus?: () => void
  onClose?: () => void
  onExpand?: () => void
}) {
  let root: HTMLElement | undefined
  let frame: HTMLIFrameElement | undefined
  let file: HTMLInputElement | undefined
  let link: ReturnType<typeof createLearnLink> | undefined
  /*
   * A fresh nonce for each load of the frame, in its address fragment: the page reads it and sends it back, and only that gets the
   * port (`handshake.ts`). The world's own comment says why the fragment, and it is the same reason here.
   */
  let nonce = newNonce()
  const [frameSrc, setFrameSrc] = createSignal(`${worldUrl()}learn/#n=${nonce}`)
  /*
   * Each load is a new frame element. An address that differs only after the `#` does not reload a frame, so its old document would
   * stay, without its port.
   */
  const [frameLoad, setFrameLoad] = createSignal(1)
  const handshake = createHandshake({ frameWindow: () => frame?.contentWindow, nonce: () => nonce })
  const [notice, setNotice] = createSignal<string | undefined>()

  /** A new document: the old one's port goes with it, and nothing it said may speak for the new one. */
  const reload = () => {
    link?.close()
    link = undefined
    nonce = newNonce()
    batch(() => {
      setFrameSrc(`${worldUrl()}learn/#n=${nonce}`)
      setFrameLoad((n) => n + 1)
    })
  }

  /** The host, when there is one: a browser without it can show the page but cannot keep the progress. */
  const host = async () => (await props.progress?.()) ?? undefined
  /** Whether there is one, read once at mounting: without it the two progress buttons are out, not silently doing nothing. */
  const [hasHost, setHasHost] = createSignal(false)

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
    /*
     * The old page's door shuts before the file is written, and the writes it already started finish first: an answer given a moment
     * ago must not land on top of the progress that was just imported.
     */
    const old = link
    link = undefined
    old?.close()
    try {
      await old?.settled()
      await commands.save(json)
      setNotice(t("learn.imported"))
    } catch (error) {
      setNotice(t("learn.importFailed", String((error as Error)?.message ?? error).slice(0, 80)))
    }
    // The page reads the progress when it opens, so an import is handed to it by opening the page again, whether or not it was written.
    reload()
  }

  /** The page proved it is the page: a new port for its window, in place of any older one. */
  const connect = async (target: Window) => {
    link?.close()
    const commands = await host()
    const channel = new MessageChannel()
    const current = createLearnLink({
      port: channel.port1,
      load: () => commands?.load() ?? Promise.resolve(null),
      save: (json) => commands?.save(json) ?? Promise.resolve(),
      ignored: (reason) => props.onIgnored?.(reason),
      unreadable: () => setNotice(t("learn.progressUnreadable")),
    })
    link = current
    channel.port1.onmessage = (event) => current.receive(event.data)
    // "*" because the frame's origin is opaque and no target origin can name it. What decides who gets the port is the nonce the
    // page just sent back from this frame's window (`handshake.hello`), not the address.
    target.postMessage({ type: PORT_OFFER, version: PROTOCOL_VERSION }, "*", [channel.port2])
  }

  /** The page's `hello`, from the frame with the nonce: only that is answered with the port. */
  const onHello = (event: MessageEvent) => {
    const verdict = handshake.hello(event)
    if (!verdict.ok) {
      // Another window's message is none of this panel's business; a frame that fails the check is worth a line.
      if (verdict.fromFrame) props.onIgnored?.(verdict.reason)
      return
    }
    void connect(event.source as Window)
  }

  onMount(() => {
    void host().then((h) => setHasHost(Boolean(h)))
    window.addEventListener("message", onHello)
    onCleanup(() => {
      window.removeEventListener("message", onHello)
      link?.close()
      link = undefined
    })
  })

  return (
    <article
      ref={root}
      data-component="learn-pane"
      data-focused={props.focused ? "true" : undefined}
      onFocusIn={() => props.onFocus?.()}
      onPointerDown={() => props.onFocus?.()}
    >
      <header data-slot="pane-header">
        <span data-slot="pane-identity" aria-hidden="true">
          <LearnGlyph />
        </span>
        <h2 data-slot="pane-title">{t("newPane.learn")}</h2>
        <div data-slot="pane-actions">
          <button
            type="button"
            data-slot="pane-action"
            onClick={() => props.onExpand?.()}
            aria-label={t("pane.expand")}
          >
            <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
              <path
                d="M1 4.5V1h3.5M11 7.5V11H7.5"
                fill="none"
                stroke="currentColor"
                stroke-width="1.2"
                stroke-linecap="round"
              />
            </svg>
          </button>
          <button type="button" data-slot="pane-action" onClick={() => props.onClose?.()} aria-label={t("pane.close")}>
            <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
              <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
            </svg>
          </button>
        </div>
      </header>

      <div data-slot="learn-body">
        <div data-slot="learn-progress">
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
        <Show when={frameLoad()} keyed>
          {(_load) => (
            <iframe
              ref={frame}
              data-slot="learn-frame"
              title={t("newPane.learn")}
              name="ade-learn"
              src={frameSrc()}
              // No `allow-same-origin`: the origin is `null`, which Tauri's IPC refuses (every registered scheme is a local origin
              // for it, so the lesson page's own would not be). No top navigation, no popups, no forms.
              sandbox="allow-scripts"
              referrerpolicy="no-referrer"
            />
          )}
        </Show>
      </div>
    </article>
  )
}

export function LearnGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3">
      <path d="M2 14V7l3-2v9M5 14V4l4-2v12M9 14V6l5 2v6M1.5 14h13" stroke-linecap="round" stroke-linejoin="round" />
      <path d="M11.5 3.2l.9 1.8 2 .3-1.45 1.4.35 2-1.8-.95-1.8.95.35-2L8.6 5.3l2-.3z" stroke-linejoin="round" />
    </svg>
  )
}
