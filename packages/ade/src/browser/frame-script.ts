/**
 * The script ADE's window runs at the start of every document in every frame.
 *
 * The desktop host registers it with `initialization_script_for_all_frames`
 * (`src-tauri/src/lib.rs`), from `src-tauri/scripts/browser-frame.js`, which
 * `bun scripts/gen-frame-script.ts` writes from this module. A test keeps the
 * two equal.
 *
 * It does two things, and nothing in ADE's own document:
 *
 * 1. **In every frame, Tauri's IPC is made inert.** On Windows every
 *    initialization script, Tauri's own included, also runs in subframes, so
 *    a page in a pane finds `window.__TAURI_INTERNALS__` and `window.ipc`.
 *    Tauri refuses the calls (S46 F0), and this is the second barrier: an
 *    invoke from a frame now fails before Tauri's client puts its key in a
 *    request, so a page that wraps `fetch` or `postMessage` has nothing to
 *    read. The objects cannot be removed (Tauri defines them
 *    non-configurable), so what goes is the one path to the key: the
 *    `Tauri-*` request headers.
 *
 * 2. **In a browser pane's frame, the inspector bridge is loaded** into the
 *    real page, so any page that can be framed can be inspected, not only
 *    the ones that ship the bridge. The pane's frame is the direct child of
 *    ADE's window named `ade-browser`. Everything the bridge sends goes out
 *    wrapped with a secret the pane gave this script and the page never sees:
 *    a page posting `visual-editor:ready` on its own is no longer believed.
 */

import { INSPECTOR_BRIDGE_SCRIPT } from "./protocol"

/** The `name` of a browser pane's frame. */
export const FRAME_NAME = "ade-browser"
/** Frame → pane: "send me the secret". Anyone in the frame can send it. */
export const FRAME_ASK = "ade-browser:ask"
/** Pane → frame: the secret. Taken by this script before the page can see it. */
export const FRAME_HELLO = "ade-browser:hello"
/** Frame → pane: one bridge message, with the secret. */
export const FRAME_ENVELOPE = "ade-browser:bridge"

export interface FrameEnvelope {
  type: typeof FRAME_ENVELOPE
  secret: string
  message: unknown
}

/** The bridge message inside an envelope, when the envelope carries `secret`. */
export function openEnvelope(data: unknown, secret: string): unknown {
  if (!data || typeof data !== "object") return undefined
  const envelope = data as Partial<FrameEnvelope>
  if (envelope.type !== FRAME_ENVELOPE || typeof envelope.secret !== "string") return undefined
  if (envelope.secret !== secret || secret.length < 16) return undefined
  return envelope.message
}

/** A fresh secret for one pane. */
export function newFrameSecret(): string {
  const bytes = new Uint8Array(18)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
}

/**
 * The script's body. Serialised with `toString`, so it must not refer to
 * anything outside itself: the constants above are repeated inside on purpose.
 *
 * Page scripts run after it, so whatever it needs later — getters, `call`,
 * `postMessage` — it takes now, before the page can replace them.
 */
export function frameGuard(win: any, bridge: (shim: any) => void): void {
  if (win.top === win) return
  const define = Object.defineProperty
  const uncurry = Function.prototype.bind.bind(Function.prototype.call)
  if (win.__ADE_FRAME__) return
  define(win, "__ADE_FRAME__", { value: true })

  // 1. IPC: no Tauri-* header can be set in a frame.
  try {
    const Base = win.Headers
    if (typeof Base === "function") {
      const test = uncurry(RegExp.prototype.test)
      const tauriHeader = /^\s*tauri-/i
      // Tauri names its headers with string literals; a page's own names pass.
      const isTauri = (name: unknown) => typeof name === "string" && test(tauriHeader, name)
      const refuse = () => {
        throw new TypeError("ADE: Tauri IPC is not available in a frame")
      }
      class FrameHeaders extends Base {
        set(name: unknown, value: unknown) {
          if (isTauri(name)) refuse()
          return super.set(name, value)
        }
        append(name: unknown, value: unknown) {
          if (isTauri(name)) refuse()
          return super.append(name, value)
        }
      }
      Object.freeze(FrameHeaders.prototype)
      Object.freeze(FrameHeaders)
      define(win, "Headers", { value: FrameHeaders, writable: false, configurable: false })
    }
  } catch {}
  try {
    const webview = win.chrome && win.chrome.webview
    if (webview) {
      const inert = Object.freeze({
        postMessage() {},
        addEventListener() {},
        removeEventListener() {},
      })
      define(win.chrome, "webview", { value: inert, writable: false, configurable: false })
    }
  } catch {}

  // 2. The inspector, in a browser pane's frame only.
  if (win.parent !== win.top || win.name !== "ade-browser") return
  /*
   * The bridge goes into a page or the mirror (about:srcdoc), not into the
   * frame's first empty document or the webview's error page: either would
   * announce the bridge over a page that never loads ("connection refused",
   * a site that refuses framing). The secret is still taken from every
   * document here, so none of them can hand it to a page.
   */
  const location = win.location || {}
  const scheme = String(location.protocol)
  const bridgeHere =
    scheme === "http:" || scheme === "https:" || scheme === "blob:" || String(location.href) === "about:srcdoc"

  const eventProto = win.MessageEvent.prototype
  const getData = uncurry(Object.getOwnPropertyDescriptor(eventProto, "data")!.get!)
  const getSource = uncurry(Object.getOwnPropertyDescriptor(eventProto, "source")!.get!)
  const stop = uncurry(win.Event.prototype.stopImmediatePropagation)
  const listen = uncurry(win.EventTarget.prototype.addEventListener)
  const parent = win.parent
  const postToParent = uncurry(parent.postMessage)
  const computed = uncurry(win.getComputedStyle)
  const push = uncurry(Array.prototype.push)
  const shift = uncurry(Array.prototype.shift)

  // A site's own copy of the bridge stays out: this one is the one ADE trusts.
  define(win, "__NIKCLI_INSPECTOR_ACTIVE__", { value: true, writable: false, configurable: false })

  let secret: string | undefined
  let started = false
  const queue: unknown[] = []
  const send = (message: unknown) => {
    if (secret === undefined) {
      push(queue, message)
      return
    }
    postToParent(parent, { type: "ade-browser:bridge", secret, message }, "*")
  }

  listen(
    win,
    "message",
    (event: unknown) => {
      if (getSource(event) !== parent) return
      const data = getData(event)
      if (!data || typeof data !== "object" || data.type !== "ade-browser:hello") return
      stop(event)
      if (!bridgeHere || secret !== undefined || typeof data.secret !== "string") return
      secret = data.secret as string
      while (queue.length) send(shift(queue))
      if (started) return
      started = true
      bridge({
        __NIKCLI_INSPECTOR_ACTIVE__: false,
        parent: { postMessage: (message: unknown) => send(message) },
        getComputedStyle: (element: unknown, pseudo?: unknown) => computed(win, element, pseudo),
        addEventListener: (type: string, handler: (event: unknown) => void, options?: unknown) => {
          if (type !== "message") return listen(win, type, handler, options)
          // Only what the pane sends reaches the bridge.
          return listen(
            win,
            "message",
            (event: unknown) => {
              if (getSource(event) !== parent) return
              const message = getData(event)
              if (message && typeof message === "object" && message.type === "ade-browser:hello") return
              handler({ data: message, source: parent })
            },
            options,
          )
        },
      })
    },
    true,
  )
  if (bridgeHere) postToParent(parent, { type: "ade-browser:ask" }, "*")
}

/** The whole script, as the host injects it. */
export function frameScript(): string {
  return [
    "// Generated by packages/ade/scripts/gen-frame-script.ts from src/browser/frame-script.ts. Do not edit.",
    `;(${frameGuard.toString()})(window, function (window) {${INSPECTOR_BRIDGE_SCRIPT}});`,
    "",
  ].join("\n")
}
