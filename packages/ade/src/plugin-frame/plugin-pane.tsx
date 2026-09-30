import { For, Show, createEffect, createSignal, on, onCleanup, onMount } from "solid-js"
import { locale, t } from "../i18n"
import type { Host } from "../host/shell"
import { createActivation, type Phase } from "./activation"
import { API_VERSION, knownPermissions, type Chord } from "./api"
import { pluginPicture, type Picture, type PictureInput } from "./bridge"
import { PORT_OFFER, createHandshake, newNonce } from "./handshake"
import { pluginBooks, forgetPlugin } from "./books"
import { pluginsChanged, pluginsRevision } from "./changes"
import { grantedFor } from "./grants"
import { markFramePlugins } from "./marker"
import { createLifecycle } from "./lifecycle"
import { createLink } from "./link"
import { pluginFrameUrl } from "./frame-url"
import { permissionText } from "./words"
import "./plugin-frame.css"

/**
 * The panel of a plugin in a frame: the frame, ADE's end of the channel, and the questions that are ADE's to ask.
 *
 * The frame is sandboxed to an opaque origin, so Tauri's IPC refuses it, and what runs in it can only ask ADE for what its permissions allow
 * (`api.ts`). The panel pauses it when it cannot be seen and lets the frame go after five minutes (`createLifecycle`). Which version is
 * switched on, and what happens when it does not start, is `activation.ts`. Anything that asks the user (a permission an update adds,
 * an uninstall) asks in this panel's own DOM, never in the frame.
 *
 * A `.tsx`, so its wiring is not reachable from `bun test`; what it decides is in `api.ts`, `link.ts`, `bridge.ts`, `activation.ts`,
 * `grants.ts` and `lifecycle.ts`, which are.
 */

export type FramePaneInput = Omit<PictureInput, "salt" | "previous">

export function PluginFramePane(props: {
  pluginId: string
  /** The name on the panel's header and its placeholder. */
  title: string
  /** The workbench as the plugin's picture is made from it; undefined while there is nothing to show. */
  input: () => FramePaneInput | undefined
  host: () => Promise<Host | undefined>
  focused: boolean
  /** ADE focuses a session's pane; only ever for one the plugin was shown. */
  onFocusPane: (paneId: string) => void
  /** ADE reads the chord as one of its own bindings and runs it if it is navigation; whether it was. */
  onChord: (chord: Chord) => boolean
  /** A message the plugin sent that ADE refused or dropped, and why. */
  onIgnored?: (reason: string) => void
  /** The version that was switched on did not start and the earlier one is back. */
  onRolledBack?: (name: string) => void
  /** «Installa» on the placeholder: takes the user to where plugins are installed. */
  onInstall: (id: string) => void
  onFocus?: () => void
  onClose?: () => void
  onExpand?: () => void
}) {
  const books = pluginBooks()
  let root: HTMLElement | undefined
  let frame: HTMLIFrameElement | undefined
  let link: ReturnType<typeof createLink> | undefined
  // A fresh nonce for each load of the frame, in its address fragment (`handshake.ts`).
  let nonce = newNonce()
  /** What the plugin in the frame is granted: set with each load, from its manifest and what the user accepted. */
  let granted = [] as ReturnType<typeof knownPermissions>
  let previous: Picture | undefined
  const [frameSrc, setFrameSrc] = createSignal(pluginFrameUrl(props.pluginId, nonce))
  const [loaded, setLoaded] = createSignal(true)
  const [phase, setPhase] = createSignal<Phase>({ kind: "checking" })
  const [dev, setDev] = createSignal(false)
  const [asking, setAsking] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const handshake = createHandshake({ frameWindow: () => frame?.contentWindow, nonce: () => nonce })
  const timer = (fn: () => void, ms: number) => {
    const handle = setTimeout(fn, ms)
    return () => clearTimeout(handle)
  }

  const reloadFrame = () => {
    nonce = newNonce()
    setFrameSrc(pluginFrameUrl(props.pluginId, nonce))
  }

  const activation = createActivation(props.pluginId, {
    list: async () => {
      const host = await props.host()
      const all = (await host?.pluginList?.()) ?? []
      return all.find((plugin) => plugin.id === props.pluginId)
    },
    commit: async () => {
      const host = await props.host()
      if (!host?.pluginCommit) throw new Error("questo host non può attivare plugin")
      return host.pluginCommit(props.pluginId)
    },
    rollback: async () => {
      const host = await props.host()
      if (!host?.pluginRollback) throw new Error("questo host non può tornare a una versione precedente")
      return host.pluginRollback(props.pluginId)
    },
    accepted: () => books.grants.accepted(props.pluginId),
    accept: (permissions) => books.grants.accept(props.pluginId, permissions),
    rejected: { add: (id, version) => books.rejected.add(id, version) },
    schedule: timer,
    phase: (next) => {
      setPhase(next)
      if (next.kind === "loading") {
        // A plugin served from a folder is the developer's own: what its manifest names is granted. An installed one is granted what the user accepted.
        setDev(next.dev)
        granted = next.dev ? knownPermissions(next.permissions) : grantedFor(next.permissions, books.grants.accepted(props.pluginId))
        link?.close()
        link = undefined
        reloadFrame()
        setLoaded(true)
      }
      if (next.kind === "consent") setAsking(true)
      if (next.kind === "rolled-back") {
        props.onRolledBack?.(props.title)
        // The earlier version is `current` again: load it.
        void activation.open()
      }
    },
  })

  const hello = () => ({
    locale: locale(),
    theme: document.documentElement.dataset.theme === "light" ? "light" : "dark",
    reducedMotion: typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches,
  })

  /** The plugin proved it is the plugin: a new port for its window, in place of any older one. */
  const connect = (target: Window) => {
    link?.close()
    const channel = new MessageChannel()
    const current = createLink({
      port: channel.port1,
      granted,
      hello,
      picture: () => {
        const input = props.input()
        if (!input) return undefined
        previous = pluginPicture({ ...input, salt: books.salts.of(props.pluginId), ...(previous ? { previous } : {}) })
        return previous
      },
      focusPane: props.onFocusPane,
      runChord: props.onChord,
      // The frame cannot give the focus back; blurring it hands it to ADE's own document, whose shortcuts listen on the window.
      releaseFocus: () => frame?.blur(),
      storageGet: async () => {
        const host = await props.host()
        if (!host?.pluginStorageGet) throw new Error("questo host non ha uno spazio per i plugin")
        return host.pluginStorageGet(props.pluginId)
      },
      storageSet: async (json) => {
        const host = await props.host()
        if (!host?.pluginStorageSet) throw new Error("questo host non ha uno spazio per i plugin")
        await host.pluginStorageSet(props.pluginId, json)
      },
      ignored: (reason) => props.onIgnored?.(reason),
      schedule: timer,
      now: () => Date.now(),
      onDead: () => {
        if (link === current) link = undefined
      },
      onReady: () => activation.ready(),
    })
    link = current
    channel.port1.onmessage = (event) => current.receive(event.data)
    // "*" because the frame's origin is opaque and no target origin can name it. What decides who gets the port is the nonce the plugin just
    // sent back from this frame's window (`handshake.hello`), not the address.
    target.postMessage({ type: PORT_OFFER, version: API_VERSION }, "*", [channel.port2])
    current.start()
  }

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
      setLoaded(false)
    },
    load: () => {
      // A new frame, a new secret: nothing said to the old one can be replayed to it.
      reloadFrame()
      setLoaded(true)
    },
    schedule: timer,
  })

  // A plugin installed or removed elsewhere (the list in the settings, an update that finished): this panel looks again.
  createEffect(
    on(
      pluginsRevision,
      async () => {
        const host = await props.host()
        const entry = (await host?.pluginList?.().catch(() => undefined))?.find((plugin) => plugin.id === props.pluginId)
        const present = Boolean(entry && (entry.current || entry.pending))
        const kind = phase().kind
        const showsIt = kind === "loading" || kind === "ready" || kind === "consent"
        if (present !== showsIt) void activation.open()
      },
      { defer: true },
    ),
  )

  // The plugin hears what changed in ADE as it changes.
  createEffect(() => {
    props.input()
    link?.push()
  })

  onMount(() => {
    void activation.open()
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
    activation.dispose()
    lifecycle.dispose()
    link?.close()
    link = undefined
  })

  const uninstall = async () => {
    setBusy(true)
    try {
      const host = await props.host()
      await host?.pluginUninstall?.(props.pluginId)
      forgetPlugin(props.pluginId)
      markFramePlugins(((await host?.pluginList?.().catch(() => [])) ?? []).length > 0)
      pluginsChanged()
    } finally {
      setBusy(false)
      void activation.open()
    }
  }

  const running = () => {
    const kind = phase().kind
    return kind === "loading" || kind === "ready"
  }

  return (
    <article
      ref={root}
      data-component="plugin-frame-pane"
      data-plugin={props.pluginId}
      data-phase={phase().kind}
      data-focused={props.focused ? "true" : undefined}
      onFocusIn={() => props.onFocus?.()}
      onPointerDown={() => props.onFocus?.()}
    >
      <header data-slot="pane-header">
        <span data-slot="pane-identity" aria-hidden="true">
          <PluginGlyph />
        </span>
        <h2 data-slot="pane-title">{props.title}</h2>
        <Show when={dev() && running()}>
          <span data-slot="plugin-dev-badge">{t("plugin.dev")}</span>
        </Show>
        <div data-slot="pane-actions">
          <button type="button" data-slot="pane-action" onClick={() => props.onExpand?.()} aria-label={t("pane.expand")}>
            <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
              <path d="M1 4.5V1h3.5M11 7.5V11H7.5" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
            </svg>
          </button>
          <button type="button" data-slot="pane-action" onClick={() => props.onClose?.()} aria-label={t("pane.close")}>
            <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
              <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
            </svg>
          </button>
        </div>
      </header>

      <div data-slot="plugin-body">
        <Show when={phase().kind === "absent"}>
          <div data-slot="plugin-placeholder" role="status">
            <p>{t("plugin.absent", props.title)}</p>
            <button type="button" data-slot="plugin-install" onClick={() => props.onInstall(props.pluginId)}>
              {t("plugin.install")}
            </button>
          </div>
        </Show>

        <Show when={phase().kind === "failed" ? (phase() as Extract<Phase, { kind: "failed" }>) : undefined}>
          {(failed) => (
            <div data-slot="plugin-failed" role="alert">
              <p>{t("plugin.failed", props.title, failed().reason)}</p>
              <button type="button" data-slot="plugin-uninstall" disabled={busy()} onClick={() => void uninstall()}>
                {t("plugin.uninstall")}
              </button>
            </div>
          )}
        </Show>

        <Show when={asking() && phase().kind === "consent" ? (phase() as Extract<Phase, { kind: "consent" }>) : undefined}>
          {(consent) => (
            <div data-slot="plugin-consent" role="alertdialog" aria-label={t("plugin.consent.title", props.title, consent().version)}>
              <p data-slot="plugin-consent-title">{t("plugin.consent.title", props.title, consent().version)}</p>
              <ul>
                <For each={consent().added}>{(permission) => <li>{permissionText(permission)}</li>}</For>
              </ul>
              <div data-slot="plugin-consent-actions">
                <button
                  type="button"
                  data-slot="plugin-consent-allow"
                  onClick={() => {
                    setAsking(false)
                    void activation.answer(true)
                  }}
                >
                  {t("plugin.consent.allow")}
                </button>
                <button
                  type="button"
                  data-slot="plugin-consent-keep"
                  onClick={() => {
                    setAsking(false)
                    void activation.answer(false)
                  }}
                >
                  {t("plugin.consent.keep")}
                </button>
              </div>
            </div>
          )}
        </Show>

        <Show when={running()}>
          <Show when={loaded()} fallback={<p data-slot="plugin-unloaded">{t("plugin.unloaded")}</p>}>
            <iframe
              ref={frame}
              data-slot="plugin-frame"
              title={props.title}
              name={`ade-plugin-${props.pluginId}`}
              src={frameSrc()}
              // No `allow-same-origin`: the origin is `null`, which Tauri's IPC refuses (every registered scheme is a local origin for it, so
              // the plugin's own would not be). No top navigation, no popups, no forms, no pointer lock.
              sandbox="allow-scripts"
              referrerpolicy="no-referrer"
              // A navigation takes the document and the port with it: ask whether the one at the other end is still there.
              onLoad={() => link?.probe()}
            />
          </Show>
        </Show>
      </div>
    </article>
  )
}

export function PluginGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3">
      <path d="M6 2v3M10 2v3M4 5h8v3a4 4 0 0 1-8 0V5zM8 12v2" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  )
}
