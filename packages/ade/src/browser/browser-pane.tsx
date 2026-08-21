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
import { HANDSHAKE_TIMEOUT_MS, type Fidelity } from "./handshake"
import {
  INSPECTOR_BRIDGE_SCRIPT,
  type BridgeMessage,
  type InspectedElement,
} from "./protocol"
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
  const [fidelity, setFidelity] = createSignal<Fidelity>("pending")

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
        const baseHref = target.endsWith("/") ? target : `${target}/`
        const headInjection = `<meta charset="utf-8"><base href="${baseHref}"><script>${INSPECTOR_BRIDGE_SCRIPT}<\/script>`

        let injected = html
        if (injected.includes("<head>")) {
          injected = injected.replace("<head>", `<head>${headInjection}\n`)
        } else if (injected.includes("<html>")) {
          injected = injected.replace("<html>", `<html>\n<head>${headInjection}\n</head>\n`)
        } else {
          injected = `${headInjection}\n${injected}`
        }

        setFidelity("mirror")
        setSrcdoc(injected)
        setLoadState("ready")
        setLoadError(undefined)
        setLoadToken((v) => v + 1)
        return
      }
      setLoadError(`${res.status} ${res.statusText}`)
    } catch (err) {
      if (!isCurrent()) return
      setLoadError(err instanceof Error ? err.message : String(err))
    }

    // CORS fetch failed; probe with no-cors to distinguish "server alive without CORS"
    // from "server not running".
    try {
      await fetch(target, { mode: "no-cors" })
      if (!isCurrent()) return
      // Server is reachable, but cross-origin without bridge
      setLoadError(undefined)
      setFidelity("none")
      setLoadState("ready")
    } catch {
      if (!isCurrent()) return
      setFidelity("none")
      setLoadState("unreachable")
      setLoadError("Server non raggiungibile")
    }
  }

  const startHandshake = (target: string, generation: number) => {
    if (handshakeTimer) clearTimeout(handshakeTimer)
    handshakeTimer = setTimeout(() => {
      if (generation !== loadGeneration) return
      if (fidelity() === "pending") {
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
    setFidelity("pending")
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

    // Try same-origin direct script injection if possible
    try {
      const doc = iframeRef?.contentDocument
      if (doc && !doc.getElementById("__nikcli_hover_outline")) {
        const script = doc.createElement("script")
        script.textContent = INSPECTOR_BRIDGE_SCRIPT
        ;(doc.head ?? doc.body)?.appendChild(script)
      }
    } catch {
      // Cross-origin iframe rejects contentDocument access
    }

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
      setFidelity(srcdoc() === null ? "native" : "mirror")
      setLoadState("ready")
      syncMode()
      return
    }

    if (data.type === "visual-editor:element-selected") {
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
          <Show when={viewportFit().isResponsive}>
            <iframe
              ref={iframeRef}
              data-slot="browser-frame"
              src={srcdoc() ? undefined : url()}
              srcdoc={srcdoc() ?? undefined}
              onLoad={onFrameLoad}
              sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-modals"
              title={props.title || "Browser preview"}
            />
          </Show>

          <Show when={!viewportFit().isResponsive}>
            <div
              data-slot="browser-viewport-scaler"
              style={{
                width: `${viewportFit().viewportWidth}px`,
                height: `${viewportFit().viewportHeight}px`,
                transform: `scale(${viewportFit().scale})`,
                "transform-origin": "top center",
              }}
            >
              <iframe
                ref={iframeRef}
                data-slot="browser-frame"
                src={srcdoc() ? undefined : url()}
                srcdoc={srcdoc() ?? undefined}
                onLoad={onFrameLoad}
                sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-modals"
                title={props.title || "Browser preview"}
              />
            </div>
          </Show>

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
