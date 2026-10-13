import { Show, batch, createSignal, onCleanup, onMount } from "solid-js"
import { createHandshake, newNonce } from "../handshake"
import { PORT_OFFER, PROTOCOL_VERSION, worldUrl } from "../protocol"
import { createLearnLink } from "./link"
import { locale, t } from "../../i18n"

/**
 * The lesson page in a frame, and ADE's end of its channel.
 *
 * It is the world's own arrangement — an origin of its own, a nonce in the address, one `MessageChannel` port and nothing else on it —
 * with everything the world needs and this does not: no snapshot of the workbench, no commands, no chords, no GPU. Which is why it opens
 * and works with RaguVerse switched off, and on a machine with no WebGPU: what is inside the frame is text and a few buttons.
 *
 * Two frames can be on screen at once (the world and a lesson over it): each has its own nonce and its own port, and a `hello` that
 * carries the other one's nonce, or comes from the other one's window, is none of this frame's business.
 *
 * What it decides is in `link.ts` and `progress.ts`; this is the wiring.
 */

export interface LearnProgressHost {
  /** The progress as it is on disk. */
  load: () => Promise<unknown>
  /** Replaces it. The value has already been checked against the shape. */
  save: (json: string) => Promise<void>
}

/** Where the page opens: the lessons, or the game (`&a=` in the address; the page believes only these two). */
export type LearnOpening = "percorsi" | "gioco"

export interface LearnFrameApi {
  /** A new document: the old one's port goes with it, and nothing it said may speak for the new one. */
  reload: () => void
  /** Shuts the page's door and waits for the writes it already started: what is written next may not be overwritten by an answer given a moment ago. */
  retire: () => Promise<void>
  /** The focus goes into the page, so that the keyboard works on it at once. */
  focus: () => void
}

/** The address of the lesson page for one load: the nonce, ADE's language, and where to open. */
export function learnSource(nonce: string, place: LearnOpening, language: string): string {
  return `${worldUrl()}learn/#n=${nonce}&l=${language}&a=${place}`
}

export function LearnFrame(props: {
  place: LearnOpening
  /** ADE's commands for the progress; absent where there is no host, and then the frame only shows the page. */
  progress?: () => Promise<LearnProgressHost | undefined>
  /** A message the page sent that ADE ignored, and why. */
  onIgnored?: (reason: string) => void
  /** The file on disk is not a progress ADE can read, so it is left alone. */
  onUnreadable?: () => void
  /** The learner pressed Esc in the page. */
  onClose?: () => void
  /** The frame takes the focus when it is there and each time it loads. */
  autofocus?: boolean
  /** The frame's own commands, handed over once it is built. */
  api?: (api: LearnFrameApi) => void
}) {
  let frame: HTMLIFrameElement | undefined
  let link: ReturnType<typeof createLearnLink> | undefined
  /*
   * A fresh nonce for each load of the frame, in its address fragment: the page reads it and sends it back, and only that gets the
   * port (`handshake.ts`). The world's own comment says why the fragment, and it is the same reason here.
   */
  let nonce = newNonce()
  const [frameSrc, setFrameSrc] = createSignal(learnSource(nonce, props.place, locale()))
  /*
   * Each load is a new frame element. An address that differs only after the `#` does not reload a frame, so its old document would
   * stay, without its port.
   */
  const [frameLoad, setFrameLoad] = createSignal(1)
  const handshake = createHandshake({ frameWindow: () => frame?.contentWindow, nonce: () => nonce })

  /** Which `connect` is the latest: one that was waiting for the host when another began, or when the page was reloaded or retired, is out of date and offers nothing. */
  let connecting = 0
  const reload = () => {
    // A connect still waiting for the host belongs to the document that is going away: it must not open a door for it afterwards.
    connecting++
    link?.close()
    link = undefined
    nonce = newNonce()
    batch(() => {
      setFrameSrc(learnSource(nonce, props.place, locale()))
      setFrameLoad((n) => n + 1)
    })
  }

  const retire = async () => {
    // The same: a connect that finishes after the door was shut would open it again, for the page that is being retired.
    connecting++
    const old = link
    link = undefined
    old?.close()
    await old?.settled()
  }

  /** The page proved it is the page: a new port for its window, in place of any older one. */
  const connect = async (target: Window) => {
    link?.close()
    const turn = ++connecting
    const commands = await props.progress?.()
    if (turn !== connecting) return
    const channel = new MessageChannel()
    const current = createLearnLink({
      port: channel.port1,
      load: () => commands?.load() ?? Promise.resolve(null),
      save: (json) => commands?.save(json) ?? Promise.resolve(),
      ignored: (reason) => props.onIgnored?.(reason),
      unreadable: () => props.onUnreadable?.(),
      close: () => props.onClose?.(),
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
      // Another window's message (the world's, say) is none of this frame's business; a frame that fails the check is worth a line.
      if (verdict.fromFrame) props.onIgnored?.(verdict.reason)
      return
    }
    void connect(event.source as Window)
  }

  const focus = () => frame?.focus()
  props.api?.({ reload, retire, focus })

  onMount(() => {
    window.addEventListener("message", onHello)
    if (props.autofocus) focus()
    onCleanup(() => {
      window.removeEventListener("message", onHello)
      // A connect still waiting for the host must not open a door for a frame that is gone.
      connecting++
      link?.close()
      link = undefined
    })
  })

  return (
    <Show when={frameLoad()} keyed>
      {(_load) => (
        <iframe
          ref={frame}
          data-slot="learn-frame"
          title={t("learn.title")}
          name="ade-learn"
          src={frameSrc()}
          // No `allow-same-origin`: the origin is `null`, which Tauri's IPC refuses (every registered scheme is a local origin
          // for it, so the lesson page's own would not be). No top navigation, no popups, no forms.
          sandbox="allow-scripts"
          referrerpolicy="no-referrer"
          onLoad={() => {
            if (props.autofocus) focus()
          }}
        />
      )}
    </Show>
  )
}
