import { Show, createEffect, createSignal, onCleanup, onMount } from "solid-js"
import { createLifecycle } from "./lifecycle"
import { createHandshake, newNonce } from "./handshake"
import { createLink } from "./link"
import { createPlayerStore, type SpotStorage } from "./player"
import { PORT_OFFER, PROTOCOL_VERSION, worldUrl, type Command, type Snapshot } from "./protocol"
import type { ForwardedChord } from "./chords"
import "./nikverse.css"
import { t } from "../i18n"

/**
 * The NikVerse panel: a frame with the world in it, and ADE's end of the channel.
 *
 * The frame is sandboxed to an opaque origin, so Tauri's IPC refuses it, and
 * what runs in it can only ask ADE for the few things on the allowlist. The panel
 * pauses it when it cannot be seen and lets the frame go after five minutes
 * (`createLifecycle`); when it comes back the frame starts again from a fresh
 * picture. Anything that changes something asks in this panel's own DOM, never
 * in the frame.
 *
 * A `.tsx`, so its wiring is not reachable from `bun test`; what it decides is
 * in `protocol.ts`, `link.ts`, `snapshot.ts` and `lifecycle.ts`, which are.
 */
/** ADE's own storage, when there is one to use (it may be missing or throw). */
function spotStorage(): SpotStorage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage
  } catch {
    return undefined
  }
}

/**
 * Where the character stood, kept outside the component: «Apri sessione» unmounts the pane and the way
 * back mounts a new one, which must find the character where it was even when storage is not there.
 */
const places = createPlayerStore(spotStorage())

export function NikversePane(props: {
  /** The picture of ADE now; undefined while there is nothing to show. */
  picture: () => Snapshot | undefined
  focused: boolean
  onOpenSession: (paneId: string) => void
  onFocusProject: (shopId: string) => void
  /** A shortcut the world forwarded: ADE reads it as its own binding and runs it only if it is navigation. */
  onChord: (chord: ForwardedChord) => void
  /** A message the world sent that ADE ignored, and why. */
  onIgnored?: (reason: string) => void
  onFocus?: () => void
  onClose?: () => void
  onExpand?: () => void
}) {
  let root: HTMLElement | undefined
  let frame: HTMLIFrameElement | undefined
  let link: ReturnType<typeof createLink> | undefined
  /*
   * A fresh nonce for each load of the frame, in its address fragment: the
   * world reads it and sends it back, and only that gets the port (`handshake.ts`).
   */
  let nonce = newNonce()
  const sourceFor = (secret: string) => `${worldUrl()}#n=${secret}`
  const [frameSrc, setFrameSrc] = createSignal(sourceFor(nonce))
  const handshake = createHandshake({ frameWindow: () => frame?.contentWindow, nonce: () => nonce })
  const [loaded, setLoaded] = createSignal(true)
  const [asking, setAsking] = createSignal<{ command: Command; approve: () => void }>()

  const run = (command: Command) => {
    switch (command.cmd) {
      case "open-session":
        return props.onOpenSession(command.paneId)
      case "focus-project":
        return props.onFocusProject(command.project)
      case "chord":
        return props.onChord(command)
      case "release-focus":
        // The frame cannot give the focus back; blurring it hands it to ADE's own document, whose shortcuts listen on the window.
        return frame?.blur()
    }
  }

  /** The world proved it is the world: a new port for its window, in place of any older one. */
  const connect = (target: Window) => {
    link?.close()
    const channel = new MessageChannel()
    const current = createLink({
      port: channel.port1,
      picture: props.picture,
      run,
      ask: (command, approve) => setAsking({ command, approve }),
      ignored: (reason) => props.onIgnored?.(reason),
      schedule: (fn, ms) => {
        const timer = setTimeout(fn, ms)
        return () => clearTimeout(timer)
      },
      onDead: () => {
        if (link === current) link = undefined
      },
      // Where the character stood is ADE's to keep: the frame is unloaded when it is not seen.
      player: places.load,
      savePlayer: places.save,
    })
    link = current
    channel.port1.onmessage = (event) => current.receive(event.data)
    // "*" because the frame's origin is opaque and no target origin can name it. What decides who gets the
    // port is the nonce the world just sent back from this frame's window (`handshake.hello`), not the address.
    target.postMessage({ type: PORT_OFFER, version: PROTOCOL_VERSION }, "*", [channel.port2])
  }

  /** The world's `hello`, from the frame with the nonce: only that is answered with the port. */
  const onHello = (event: MessageEvent) => {
    const verdict = handshake.hello(event)
    if (!verdict.ok) {
      // Another window's message is none of this panel's business; a frame that fails the check is worth a line.
      if (verdict.fromFrame) props.onIgnored?.(verdict.reason)
      return
    }
    connect(event.source as Window)
  }

  const lifecycle = createLifecycle({
    pause: () => link?.pause(),
    resume: () => link?.resume(),
    unload: () => {
      link?.close()
      link = undefined
      setAsking(undefined)
      setLoaded(false)
    },
    load: () => {
      // A new frame, a new secret: nothing said to the old one can be replayed to it.
      nonce = newNonce()
      setFrameSrc(sourceFor(nonce))
      setLoaded(true)
    },
    schedule: (fn, ms) => {
      const timer = setTimeout(fn, ms)
      return () => clearTimeout(timer)
    },
  })

  // The world hears what changed in ADE as it changes.
  createEffect(() => {
    props.picture()
    link?.push()
  })

  onMount(() => {
    // Visible means the window is shown and the panel is on screen (not behind another section, nor scrolled away).
    let onScreen = true
    const apply = () => lifecycle.setVisible(onScreen && document.visibilityState !== "hidden")
    const observer =
      typeof IntersectionObserver === "undefined" || !root
        ? undefined
        : new IntersectionObserver((entries) => {
            onScreen = entries.some((entry) => entry.isIntersecting)
            apply()
          })
    if (root) observer?.observe(root)
    document.addEventListener("visibilitychange", apply)
    window.addEventListener("message", onHello)
    // A click in the frame moves the window's focus into it, which the panel above cannot hear.
    const onBlur = () => {
      if (document.activeElement === frame) props.onFocus?.()
    }
    window.addEventListener("blur", onBlur)
    onCleanup(() => {
      observer?.disconnect()
      document.removeEventListener("visibilitychange", apply)
      window.removeEventListener("message", onHello)
      window.removeEventListener("blur", onBlur)
    })
  })

  onCleanup(() => {
    lifecycle.dispose()
    link?.close()
    link = undefined
  })

  return (
    <article
      ref={root}
      data-component="nikverse-pane"
      data-focused={props.focused ? "true" : undefined}
      onFocusIn={() => props.onFocus?.()}
      onPointerDown={() => props.onFocus?.()}
    >
      <header data-slot="pane-header">
        <span data-slot="pane-identity" aria-hidden="true">
          <NikverseGlyph />
        </span>
        <h2 data-slot="pane-title">{t("newPane.nikverse")}</h2>
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
              <path
                d="M2.5 2.5l7 7M9.5 2.5l-7 7"
                fill="none"
                stroke="currentColor"
                stroke-width="1.2"
                stroke-linecap="round"
              />
            </svg>
          </button>
        </div>
      </header>

      <Show when={asking()}>
        {(pending) => (
          <div data-slot="nikverse-ask" role="alert">
            <span>{t("nikverse.ask", pending().command.cmd)}</span>
            <button
              type="button"
              data-slot="nikverse-allow"
              onClick={() => {
                const { approve } = pending()
                setAsking(undefined)
                approve()
              }}
            >
              {t("nikverse.allow")}
            </button>
            <button type="button" data-slot="nikverse-deny" onClick={() => setAsking(undefined)}>
              {t("nikverse.deny")}
            </button>
          </div>
        )}
      </Show>

      <div data-slot="nikverse-body">
        <Show when={loaded()} fallback={<p data-slot="nikverse-unloaded">{t("nikverse.unloaded")}</p>}>
          <iframe
            ref={frame}
            data-slot="nikverse-frame"
            title={t("newPane.nikverse")}
            name="ade-nikverse"
            src={frameSrc()}
            // No `allow-same-origin`: the origin is `null`, which Tauri's IPC refuses (every registered scheme is
            // a local origin for it, so the world's own would not be). No top navigation, no popups, no forms.
            // `allow-pointer-lock` alone besides the scripts: the third-person camera turns with a captured mouse.
            sandbox="allow-scripts allow-pointer-lock"
            referrerpolicy="no-referrer"
            // A navigation takes the document and the port with it: ask whether the one at the other end is still there.
            onLoad={() => link?.probe()}
          />
        </Show>
      </div>
    </article>
  )
}

export function NikverseGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3">
      <path d="M2 14V7l3-2v9M5 14V4l4-2v12M9 14V6l5 2v6M1.5 14h13" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  )
}
