/**
 * Browser Pane Component for the ADE.
 *
 * Provides a live, interactive web page inside a grid pane. Supports URL navigation,
 * device preset emulation with aspect-ratio-preserving scaling, visual element
 * inspection, and prompt context dispatching to the agent.
 */

import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  type JSX,
} from "solid-js"
import { formatSelectionContext } from "./element-context"
import {
  HANDSHAKE_TIMEOUT_MS,
  INITIAL_HANDSHAKE_STATE,
  reduceFidelity,
  type Fidelity,
  type HandshakeEvent,
} from "./handshake"
import {
  INSPECTOR_BRIDGE_SCRIPT,
  type BridgeMessage,
  type InspectedElement,
} from "./protocol"
import { escapeAttribute, withLoadToken } from "./frame-url"
import { normalizeUrl } from "./url"
import { fitViewport, type DevicePreset } from "./viewport"

export interface BrowserPaneProps {
  id?: string
  title?: string
  initialUrl?: string
  focused?: boolean
  onFocus?: () => void
  onClose?: () => void
  onExpand?: () => void
  onSendPrompt?: (prompt: string, context?: string) => void
}

type LoadState = "idle" | "loading" | "ready" | "unreachable"

const DEVICE_LABELS: Record<DevicePreset, string> = {
  responsive: "Fluido",
  desktop: "Desktop",
  tablet: "Tablet",
  mobile: "Mobile",
}

/**
 * Device preset glyphs on a 16px grid, stroke-based, inheriting currentColor.
 * Text labels cost ~230px of toolbar; at pane widths below ~500px that pushes
 * the close button out of reach, so the presets carry icons plus tooltips.
 */
function DevicePresetIcon(props: { preset: DevicePreset }): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <Show when={props.preset === "responsive"}>
        <path d="M2 8h12M4.5 5.5L2 8l2.5 2.5M11.5 5.5L14 8l-2.5 2.5" />
      </Show>
      <Show when={props.preset === "desktop"}>
        <rect x="2" y="3" width="12" height="8" rx="1.5" />
        <path d="M8 11v2M5.5 13h5" />
      </Show>
      <Show when={props.preset === "tablet"}>
        <rect x="3.5" y="2" width="9" height="12" rx="1.5" />
        <path d="M7 12h2" />
      </Show>
      <Show when={props.preset === "mobile"}>
        <rect x="5" y="2" width="6" height="12" rx="1.5" />
        <path d="M7.25 12h1.5" />
      </Show>
    </svg>
  )
}

export function BrowserPane(props: BrowserPaneProps): JSX.Element {
  const defaultUrl = normalizeUrl(props.initialUrl || "http://localhost:3000") || "http://localhost:3000"

  const [url, setUrl] = createSignal(defaultUrl)
  const [inputUrl, setInputUrl] = createSignal(url())
  const [srcdoc, setSrcdoc] = createSignal<string | null>(null)
  const [loadToken, setLoadToken] = createSignal(1)
  const [loadState, setLoadState] = createSignal<LoadState>("idle")
  const [loadError, setLoadError] = createSignal<string>()
  /*
   * Fidelity is decided by the reducer in `handshake.ts`, not here.
   *
   * That reducer, and the forty assertions pinning it, were imported by
   * nothing but their own test: this component reimplemented the same
   * transitions inline, and the two had already drifted — the reducer treats
   * `load-error` as terminal, and the component had no way to reach that
   * state at all. A tested state machine that production does not use is not
   * coverage, it is a second opinion nobody asked for.
   */
  const [fidelity, setFidelityRaw] = createSignal<Fidelity>(INITIAL_HANDSHAKE_STATE.fidelity)
  const handshake = (event: HandshakeEvent) => setFidelityRaw((current) => reduceFidelity(current, event))

  const [mode, setMode] = createSignal<"browse" | "edit">("browse")
  const [device, setDevice] = createSignal<DevicePreset>("responsive")
  const [landscape, setLandscape] = createSignal(false)

  const [selection, setSelection] = createSignal<InspectedElement[]>([])
  const [promptText, setPromptText] = createSignal("")
  const [containerBox, setContainerBox] = createSignal({ width: 0, height: 0 })

  let iframeRef: HTMLIFrameElement | undefined
  let viewportContainerRef: HTMLDivElement | undefined
  let handshakeTimer: ReturnType<typeof setTimeout> | undefined
  let loadGeneration = 0

  /**
   * Messages to the frame go to `"*"`, for a page loaded by URL too.
   *
   * The frame is sandboxed without `allow-same-origin`, so every document in
   * it — mirror or live page — has an opaque origin, and a target origin of
   * `http://localhost:3000` matches nothing: the message is dropped without an
   * error. That is why Design Mode never switched on for a page carrying the
   * bridge itself. `"*"` gives nothing away: what goes out is the mode and
   * selectors the page itself sent, and what comes back is accepted only from
   * this frame's own window (`handleMessage`).
   */
  const post = (message: unknown) => {
    try {
      iframeRef?.contentWindow?.postMessage(message, "*")
    } catch {
      // Frame might be detached or cross-origin restricted
    }
  }

  const syncMode = () => {
    post({ type: "visual-editor:set-mode", mode: mode() })
  }

  // Effect runs whenever mode changes, keeping the injected inspector in sync.
  createEffect(() => {
    mode()
    syncMode()
  })

  onCleanup(() => {
    if (handshakeTimer) clearTimeout(handshakeTimer)
  })

  /**
   * Loads a mirrored srcdoc copy when the native bridge does not announce itself.
   */
  const loadMirror = async (target: string, generation: number) => {
    const isCurrent = () => generation === loadGeneration

    try {
      const res = await fetch(target, { mode: "cors" })
      if (!isCurrent()) return

      if (res.ok) {
        const html = await res.text()
        if (!isCurrent()) return

        // Inject base tag so relative asset URLs resolve against the target server,
        // and inject the bridge script into the document head.
        /*
         * Escaped, because it goes into an attribute.
         *
         * `normalizeUrl` now returns the canonical form, in which a quote is
         * already `%22`, so this is the belt to that braces: `target` also
         * arrives here from a redirect the page chose, and one unescaped `"`
         * closes the `href` and turns the rest into markup.
         */
        const baseHref = escapeAttribute(target.endsWith("/") ? target : `${target}/`)
        const headInjection = `<meta charset="utf-8"><base href="${baseHref}"><script>${INSPECTOR_BRIDGE_SCRIPT}<\/script>`

        let injected = html
        if (injected.includes("<head>")) {
          injected = injected.replace("<head>", `<head>${headInjection}\n`)
        } else if (injected.includes("<html>")) {
          injected = injected.replace("<html>", `<html>\n<head>${headInjection}\n</head>\n`)
        } else {
          injected = `${headInjection}\n${injected}`
        }

        handshake({ type: "ready", mode: "mirror" })
        setSrcdoc(injected)
        setLoadState("ready")
        setLoadError(undefined)
        setLoadToken((v) => v + 1)
        return
      }
      /*
       * A reply that is not ok is an answer, so the probe below must not run.
       *
       * It used to fall through: the 404 was recorded, then the `no-cors`
       * probe reached the very same server, succeeded, and cleared the error
       * it had just set. The pane said "ready" over a blank frame with no
       * mention of the 404 anywhere — the one case where the user needs to
       * be told the path is wrong, not that everything is fine.
       */
      handshake({ type: "load-error", error: `${res.status} ${res.statusText}` })
      setLoadState("ready")
      setLoadError(`${res.status} ${res.statusText}`)
      return
    } catch (err) {
      if (!isCurrent()) return
      setLoadError(err instanceof Error ? err.message : String(err))
    }

    // The CORS fetch threw, which says nothing about the server: a page with
    // no CORS headers throws exactly like one that is not running. The
    // `no-cors` probe tells the two apart.
    try {
      await fetch(target, { mode: "no-cors" })
      if (!isCurrent()) return
      // Server is reachable, but cross-origin without bridge
      setLoadError(undefined)
      handshake({ type: "load-error" })
      setLoadState("ready")
    } catch {
      if (!isCurrent()) return
      handshake({ type: "load-error", error: "Server non raggiungibile" })
      setLoadState("unreachable")
      setLoadError("Server non raggiungibile")
    }
  }

  const startHandshake = (target: string, generation: number) => {
    if (handshakeTimer) clearTimeout(handshakeTimer)
    handshakeTimer = setTimeout(() => {
      if (generation !== loadGeneration) return
      if (fidelity() === "pending") {
        // The reducer's own demotion: pending → mirror. Dispatched before the
        // fetch because the decision to mirror is what the timeout *is*; the
        // fetch only decides whether the mirror succeeds, and a failure comes
        // back through `load-error`.
        handshake({ type: "timeout" })
        void loadMirror(target, generation)
      }
    }, HANDSHAKE_TIMEOUT_MS)
  }

  const load = (target: string) => {
    loadGeneration += 1
    const generation = loadGeneration

    if (handshakeTimer) clearTimeout(handshakeTimer)
    setLoadState("loading")
    setLoadError(undefined)
    setSelection([])
    handshake({ type: "navigate", url: target })
    setSrcdoc(null)
    setLoadToken((v) => v + 1)

    startHandshake(target, generation)
  }

  const navigateTo = (raw: string) => {
    const normalized = normalizeUrl(raw)
    if (!normalized) return
    setUrl(normalized)
    setInputUrl(normalized)
    load(normalized)
  }

  const onFrameLoad = () => {
    if (srcdoc() !== null) {
      setLoadState("ready")
    }

    if (srcdoc() === null && fidelity() === "pending") {
      startHandshake(url(), loadGeneration)
    }

    /*
     * There used to be an attempt to reach into `contentDocument` here and
     * append the bridge script directly. It cannot work any more, and it should
     * not: the frame is sandboxed without `allow-same-origin`, so its document
     * has an opaque origin and is unreachable from here by design. That is the
     * point — a `srcdoc` document inherits the embedder's origin unless the
     * sandbox denies it, and this frame is filled with HTML fetched from
     * whatever server the address bar names.
     *
     * A page that does not ship the bridge itself still gets one: the handshake
     * times out, `loadMirror` takes a copy, and the bridge is injected into that
     * copy, where it belongs.
     */
    syncMode()
  }

  const handleMessage = (event: MessageEvent) => {
    // Untrusted source guard: ignore any message not originating from our iframe
    if (!iframeRef?.contentWindow || event.source !== iframeRef.contentWindow) return

    const data = event.data as BridgeMessage
    if (!data || typeof data !== "object" || typeof data.type !== "string") return
    if (!data.type.startsWith("visual-editor:")) return

    if (data.type === "visual-editor:ready") {
      if (handshakeTimer) clearTimeout(handshakeTimer)
      handshake({ type: "ready", mode: srcdoc() === null ? "native" : "mirror" })
      setLoadState("ready")
      syncMode()
      return
    }

    if (data.type === "visual-editor:element-selected") {
      /*
       * Only while the user has design mode on.
       *
       * The message says "the user clicked an element", but nothing about it
       * proves that: the page is the one sending it, and the page is not ADE's.
       * Outside edit mode the user has not asked this page for anything, so an
       * unprompted selection is a page writing text into a prompt box on its
       * own — and that prompt goes to an agent.
       */
      if (mode() !== "edit") return

      const element = data.element
      if (element && typeof element.selector === "string") {
        setSelection((prev) =>
          prev.some((item) => item.selector === element.selector) ? prev : [...prev, element],
        )
      }
      return
    }

    if (data.type === "visual-editor:clear-selection") {
      if (Array.isArray(data.selectors)) {
        const keep = new Set(data.selectors)
        setSelection((prev) => prev.filter((item) => keep.has(item.selector)))
      } else {
        setSelection([])
      }
    }
  }

  onMount(() => {
    window.addEventListener("message", handleMessage)
    onCleanup(() => window.removeEventListener("message", handleMessage))

    if (viewportContainerRef) {
      const observer = new ResizeObserver(([entry]) => {
        if (!entry) return
        const rect = entry.contentRect
        setContainerBox({ width: rect.width, height: rect.height })
      })
      observer.observe(viewportContainerRef)
      onCleanup(() => observer.disconnect())
    }

    load(url())
  })

  const removeElement = (selector: string) => {
    const next = selection().filter((item) => item.selector !== selector)
    setSelection(next)
    post({ type: "visual-editor:clear-selection", selectors: next.map((item) => item.selector) })
  }

  const clearSelection = () => {
    setSelection([])
    post({ type: "visual-editor:clear-selection" })
  }

  const sendPromptWithContext = () => {
    const text = promptText().trim()
    const elements = selection()
    const context = formatSelectionContext(elements, { url: url(), instruction: text || undefined })

    props.onSendPrompt?.(text, context)
    setPromptText("")
    clearSelection()
  }

  const viewportFit = createMemo(() =>
    fitViewport({
      preset: device(),
      containerWidth: containerBox().width,
      containerHeight: containerBox().height,
      landscape: landscape(),
    }),
  )

  const fidelityLabel = () => {
    switch (fidelity()) {
      case "native":
        return "Nativo (Bridge attivo)"
      case "mirror":
        return "Mirror (Copia isolata)"
      case "none":
        return "Sola lettura"
      case "pending":
      default:
        return "Connessione..."
    }
  }

  const dimensionsLabel = () => {
    const fit = viewportFit()
    if (fit.isResponsive) return "Fluido"
    const pct = Math.round(fit.scale * 100)
    return `${fit.viewportWidth}×${fit.viewportHeight} (${pct}%)`
  }

  return (
    <article
      data-component="browser-pane"
      data-focused={props.focused ? "true" : undefined}
      data-fidelity={fidelity()}
      data-mode={mode()}
      data-status={loadState()}
      onFocusIn={() => props.onFocus?.()}
      onPointerDown={() => props.onFocus?.()}
    >
      <header data-slot="browser-header">
        {/* Picked up by the grid (`grid/session-grid.tsx`); the toolbar is
            full of controls, so the pane offers one place that is only a
            handle. */}
        <span data-slot="pane-grip" title="Trascina per spostare il pannello" aria-hidden="true">
          <svg viewBox="0 0 8 12" width="8" height="12">
            <circle cx="2" cy="2" r="1" />
            <circle cx="6" cy="2" r="1" />
            <circle cx="2" cy="6" r="1" />
            <circle cx="6" cy="6" r="1" />
            <circle cx="2" cy="10" r="1" />
            <circle cx="6" cy="10" r="1" />
          </svg>
        </span>
        <div data-slot="browser-nav-group">
          <button
            type="button"
            data-slot="browser-nav-btn"
            onClick={() => iframeRef?.contentWindow?.history.back()}
            aria-label="Indietro"
            title="Indietro"
          >
            <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
              <path d="M7.5 2.5L4 6l3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
            </svg>
          </button>
          <button
            type="button"
            data-slot="browser-nav-btn"
            onClick={() => iframeRef?.contentWindow?.history.forward()}
            aria-label="Avanti"
            title="Avanti"
          >
            <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
              <path d="M4.5 2.5L8 6l-3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
            </svg>
          </button>
          <button
            type="button"
            data-slot="browser-nav-btn"
            onClick={() => load(url())}
            aria-label="Ricarica"
            title="Ricarica"
          >
            <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
              <path d="M2 6a4 4 0 1 1 1.2 2.8M2 9V6h3" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
            </svg>
          </button>
        </div>

        <div data-slot="browser-url-bar">
          <span
            data-slot="browser-status-dot"
            data-status={loadState()}
            aria-hidden="true"
          />
          <input
            type="text"
            data-slot="browser-url-input"
            value={inputUrl()}
            onInput={(e) => setInputUrl(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                navigateTo(inputUrl())
              }
            }}
            placeholder="localhost:3000 o porta :5173"
            spellcheck={false}
          />
        </div>

        <div data-slot="browser-mode-group">
          <button
            type="button"
            data-slot="browser-mode-btn"
            data-active={mode() === "browse" ? "true" : undefined}
            onClick={() => setMode("browse")}
            title="Modalità Navigazione"
          >
            Naviga
          </button>
          <button
            type="button"
            data-slot="browser-mode-btn"
            data-active={mode() === "edit" ? "true" : undefined}
            onClick={() => setMode("edit")}
            title="Modalità Ispezione ed Editing"
          >
            Ispeziona
          </button>
        </div>

        <div data-slot="browser-device-group">
          <For each={["responsive", "desktop", "tablet", "mobile"] as const}>
            {(preset) => (
              <button
                type="button"
                data-slot="browser-device-btn"
                data-active={device() === preset ? "true" : undefined}
                onClick={() => setDevice(preset)}
                title={DEVICE_LABELS[preset]}
                aria-label={DEVICE_LABELS[preset]}
              >
                <DevicePresetIcon preset={preset} />
              </button>
            )}
          </For>
          <Show when={device() !== "responsive"}>
            <button
              type="button"
              data-slot="browser-rotate-btn"
              data-active={landscape() ? "true" : undefined}
              onClick={() => setLandscape((v) => !v)}
              title="Ruota orientamento"
              aria-label="Ruota orientamento"
            >
              <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                <path d="M14 8a6 6 0 1 1-6-6c1.68 0 3.29.67 4.5 1.83L14 5.33" />
                <path d="M14 2v3.33h-3.33" />
              </svg>
            </button>
          </Show>
        </div>

        <div data-slot="browser-actions">
          <Show when={props.onExpand}>
            <button
              type="button"
              data-slot="browser-action"
              onClick={() => props.onExpand?.()}
              aria-label="Espandi pannello"
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
          </Show>
          <Show when={props.onClose}>
            <button
              type="button"
              data-slot="browser-action"
              onClick={() => props.onClose?.()}
              aria-label="Chiudi pannello"
            >
              <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
                <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
              </svg>
            </button>
          </Show>
        </div>
      </header>

      <div data-slot="browser-body">
        <div ref={viewportContainerRef} data-slot="browser-viewport-container">
          {/*
            * One iframe, always mounted.
            *
            * There used to be two, in mutually exclusive `<Show>`s sharing a
            * single `ref`: switching device preset unmounted one and mounted
            * the other, so the guest page reloaded from scratch — losing its
            * scroll, its form state and anything it had fetched — merely to
            * change the frame's width. For an instant between the two,
            * `iframeRef` also pointed at a detached node, and any
            * `postMessage` in that window went nowhere.
            *
            * The wrapper's geometry is computed reactively instead. In
            * responsive mode it carries no sizing at all, so the frame fills
            * the pane as it did before.
            */}
          <div
            data-slot="browser-viewport-fit"
            data-responsive={viewportFit().isResponsive ? "true" : undefined}
            style={
              viewportFit().isResponsive
                ? undefined
                : {
                    /*
                     * The space the *scaled* frame actually occupies.
                     *
                     * A transform does not change an element's layout box,
                     * so without this the flex parent reserved the full
                     * unscaled device height and centred that — pushing a
                     * shrunk Desktop preview off the top of the pane.
                     */
                    width: `${viewportFit().renderedWidth}px`,
                    height: `${viewportFit().renderedHeight}px`,
                  }
            }
          >
          <div
            data-slot="browser-viewport-scaler"
            data-responsive={viewportFit().isResponsive ? "true" : undefined}
            style={
              viewportFit().isResponsive
                ? undefined
                : {
                    width: `${viewportFit().viewportWidth}px`,
                    height: `${viewportFit().viewportHeight}px`,
                    transform: `scale(${viewportFit().scale})`,
                    /*
                     * Top left, and the box shrinks with the scale.
                     *
                     * With `top center` and a full-size box, a Desktop
                     * preview in a narrow pane scaled below 1 and the
                     * untransformed layout box stayed full height — so the
                     * scaled frame was laid out for a box far taller than
                     * what it drew, and the preview sat entirely above the
                     * visible area. `renderedWidth`/`renderedHeight` are
                     * what `fitViewport` computes for exactly this, and
                     * nothing used them.
                     */
                    "transform-origin": "top left",
                  }
            }
          >
            <iframe
              ref={iframeRef}
              data-slot="browser-frame"
              /*
               * Keyed on the load token so Reload actually reloads.
               *
               * `setLoadToken` was incremented and never read. In `native`
               * fidelity the Reload button rewrote `src` with the same
               * string, Solid saw no change and wrote nothing, so the frame
               * did not renavigate — and the handshake timer then fired at
               * 1500 ms and replaced a perfectly live page with a static
               * mirror of it.
               */
              data-load={loadToken()}
              src={srcdoc() ? undefined : withLoadToken(url(), loadToken())}
              srcdoc={srcdoc() ?? undefined}
              onLoad={onFrameLoad}
              sandbox="allow-scripts allow-forms allow-popups allow-modals"
              title={props.title || "Browser preview"}
            />
          </div>
          </div>

          <Show when={loadState() === "unreachable"}>
            <div data-slot="browser-error-overlay">
              <span data-slot="browser-error-icon" aria-hidden="true">
                <svg viewBox="0 0 16 16" width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">
                  <circle cx="8" cy="8" r="5.5" />
                  <path d="M2.5 8h11M8 2.5C4.8 5.3 4.8 10.7 8 13.5M8 2.5c3.2 2.8 3.2 8.2 0 11" />
                  <path d="M3.5 3.5l9 9" />
                </svg>
              </span>
              <span data-slot="browser-error-title">Impossibile caricare l'URL</span>
              <span data-slot="browser-error-msg">
                {loadError() || "Verifica che il server sia avviato e raggiungibile."}
              </span>
              <button
                type="button"
                data-slot="browser-retry-btn"
                onClick={() => load(url())}
              >
                Riprova
              </button>
            </div>
          </Show>
          
          <Show when={mode() === "edit" || selection().length > 0}>
            <div data-slot="browser-prompt-popover">
              <Show when={selection().length > 0}>
                <div data-slot="browser-selection-list">
                  <span data-slot="browser-selection-label">Contesto catturato:</span>
                  <div data-slot="browser-context-blocks">
                    <For each={selection()}>
                      {(el) => (
                        <div data-slot="browser-context-block">
                          <div data-slot="browser-context-header">
                            <span data-slot="browser-context-tag">&lt;{el.tagName}&gt;</span>
                            <Show when={el.id}>
                              <span data-slot="browser-context-id">#{el.id}</span>
                            </Show>
                            <button
                              type="button"
                              data-slot="browser-context-remove"
                              onClick={() => removeElement(el.selector)}
                              aria-label={`Rimuovi ${el.selector}`}
                            >
                              <svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
                                <path d="M4 4l8 8M12 4l-8 8" />
                              </svg>
                            </button>
                          </div>
                          <Show when={el.outerHTML}>
                            <pre data-slot="browser-context-code"><code>{el.outerHTML}</code></pre>
                          </Show>
                        </div>
                      )}
                    </For>
                  </div>
                  <button
                    type="button"
                    data-slot="browser-clear-selection"
                    onClick={clearSelection}
                  >
                    Deseleziona tutto
                  </button>
                </div>
              </Show>

              <div data-slot="browser-prompt-input-row">
                <span data-slot="browser-prompt-caret" aria-hidden="true">
                  <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M6 3l5 5-5 5" />
                  </svg>
                </span>
                <input
                  type="text"
                  data-slot="browser-prompt-input"
                  value={promptText()}
                  onInput={(e) => setPromptText(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      sendPromptWithContext()
                    } else if (e.key === "Escape") {
                      clearSelection()
                      setPromptText("")
                      setMode("browse")
                    }
                  }}
                  placeholder={
                    selection().length > 0
                      ? "Descrivi cosa modificare..."
                      : "Punta un elemento nella pagina o scrivi un'istruzione..."
                  }
                  spellcheck={false}
                />
                <button
                  type="button"
                  data-slot="browser-send-btn"
                  onClick={sendPromptWithContext}
                  disabled={!promptText().trim() && selection().length === 0}
                >
                  Invia
                </button>
              </div>
            </div>
          </Show>
        </div>
      </div>

      <footer data-slot="browser-footer">
        <span data-slot="browser-fidelity">{fidelityLabel()}</span>
        <span data-slot="browser-dimensions">{dimensionsLabel()}</span>
        <span data-slot="browser-selection-count">
          {selection().length === 0
            ? "Nessun elemento selezionato"
            : selection().length === 1
              ? "1 elemento selezionato"
              : `${selection().length} elementi selezionati`}
        </span>
      </footer>
    </article>
  )
}
