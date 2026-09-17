import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { FRAME_ENVELOPE, frameGuard, frameScript, newFrameSecret, openEnvelope } from "./frame-script"

const KEY = "invoke-key-that-must-not-leak"

/** Headers that remember every value they were given, like a page wrapping `set`. */
function spyHeaders() {
  const seen: unknown[] = []
  class SpyHeaders extends Headers {
    override set(name: string, value: string) {
      seen.push(value)
      return super.set(name, value)
    }
    override append(name: string, value: string) {
      seen.push(value)
      return super.append(name, value)
    }
  }
  return { SpyHeaders, seen }
}

/**
 * A message event shaped like a browser's: `data` and `source` are getters on
 * the prototype (happy-dom keeps them as fields), which is what a page could
 * replace and what the guard takes early.
 */
class BrowserMessageEvent extends Event {
  #data: unknown
  #source: unknown
  constructor(type: string, init: { data?: unknown; source?: unknown }) {
    super(type)
    this.#data = init.data
    this.#source = init.source
  }
  get data() {
    return this.#data
  }
  get source() {
    return this.#source
  }
}

function makeWindow(input: { name?: string; nested?: boolean; top?: boolean; href?: string }) {
  const win = new EventTarget() as any
  const topPosted: any[] = []
  const top = input.top ? win : { postMessage: (message: unknown) => topPosted.push(message) }
  const { SpyHeaders, seen } = spyHeaders()
  const webview = { postMessage: () => topPosted.push("webview") }
  Object.assign(win, {
    top,
    parent: input.nested ? { postMessage: (message: unknown) => topPosted.push(message) } : top,
    name: input.name ?? "",
    Headers: SpyHeaders,
    MessageEvent: BrowserMessageEvent,
    Event,
    EventTarget,
    getComputedStyle: () => ({}),
    chrome: { webview },
    location: new URL(input.href ?? "http://localhost:5173/"),
  })
  const fromParent = (data: unknown) => win.dispatchEvent(new BrowserMessageEvent("message", { data, source: win.parent }))
  const fromPage = (data: unknown) => win.dispatchEvent(new BrowserMessageEvent("message", { data, source: win }))
  return { win, topPosted, seen, webview, fromParent, fromPage }
}

/** What Tauri's client does before it sends an invoke. */
function tauriRequest(win: any) {
  const headers = new win.Headers({})
  headers.set("Content-Type", "application/json")
  headers.set("Tauri-Callback", "1")
  headers.set("Tauri-Error", "2")
  headers.set("Tauri-Invoke-Key", KEY)
  return headers
}

describe("the generated script", () => {
  const file = readFileSync(join(import.meta.dir, "..", "..", "src-tauri", "scripts", "browser-frame.js"), "utf8")

  test("is up to date (bun scripts/gen-frame-script.ts)", () => {
    expect(file).toBe(frameScript())
  })

  test("parses, and can be put inside a <script> of the mirror", () => {
    expect(() => new Function("window", file)).not.toThrow()
    expect(file.toLowerCase()).not.toContain("</script")
  })
})

describe("frameGuard: ADE's own document", () => {
  test("changes nothing", () => {
    const { win, seen } = makeWindow({ top: true })
    const before = win.Headers
    let started = false
    frameGuard(win, () => (started = true))
    expect(win.Headers).toBe(before)
    expect(() => tauriRequest(win)).not.toThrow()
    expect(seen).toContain(KEY)
    expect(started).toBe(false)
  })
})

describe("frameGuard: any frame", () => {
  test("Tauri's client fails before the key is set, and no page wrapper sees it", () => {
    const { win, seen } = makeWindow({})
    frameGuard(win, () => {})
    expect(() => tauriRequest(win)).toThrow("not available in a frame")
    expect(seen).not.toContain(KEY)
    expect(() => new win.Headers().append("tauri-invoke-key", KEY)).toThrow()
    expect(seen).not.toContain(KEY)
  })

  test("a page's own headers still work", () => {
    const { win } = makeWindow({})
    frameGuard(win, () => {})
    const headers = new win.Headers({ accept: "text/html" })
    headers.set("X-Requested-With", "fetch")
    headers.append("Authorization", "Bearer page-token")
    expect(headers.get("x-requested-with")).toBe("fetch")
    expect(headers instanceof Headers).toBe(true)
  })

  test("the guard cannot be taken back", () => {
    const { win } = makeWindow({})
    frameGuard(win, () => {})
    const guarded = win.Headers
    expect(() => {
      "use strict"
      win.Headers = Headers
    }).toThrow()
    expect(win.Headers).toBe(guarded)
    expect(() => Object.defineProperty(win, "Headers", { value: Headers })).toThrow()
    expect(Object.isFrozen(guarded.prototype)).toBe(true)
  })

  test("the webview's postMessage goes nowhere", () => {
    const { win, topPosted, webview } = makeWindow({})
    frameGuard(win, () => {})
    expect(win.chrome.webview).not.toBe(webview)
    win.chrome.webview.postMessage("ipc")
    expect(topPosted).not.toContain("webview")
  })

  test("runs once per document", () => {
    const { win } = makeWindow({})
    frameGuard(win, () => {})
    const guarded = win.Headers
    frameGuard(win, () => {})
    expect(win.Headers).toBe(guarded)
  })

  test("a frame that is not a pane gets no bridge", () => {
    for (const input of [
      { name: "" },
      { name: "something" },
      { name: "ade-browser", nested: true },
      // The webview's page for "connection refused" or a refused frame,
      // and the frame's first empty document, before the page loads.
      { name: "ade-browser", href: "chrome-error://chromewebdata/" },
      { name: "ade-browser", href: "about:blank" },
    ]) {
      const { win, topPosted } = makeWindow(input)
      let started = false
      frameGuard(win, () => (started = true))
      expect(topPosted).toEqual([])
      expect(started).toBe(false)
    }
  })
})

describe("frameGuard: a browser pane's frame", () => {
  const secret = "0123456789abcdef0123"

  test("pages, blobs and the mirror get the bridge", () => {
    for (const href of ["https://example.com/", "blob:null/8d1c", "about:srcdoc"]) {
      const { win, fromParent } = makeWindow({ name: "ade-browser", href })
      let started = false
      frameGuard(win, () => (started = true))
      fromParent({ type: "ade-browser:hello", secret })
      expect(started).toBe(true)
    }
  })

  test("a document without the bridge still keeps the secret from the page", () => {
    const { win, topPosted, fromParent } = makeWindow({ name: "ade-browser", href: "about:blank" })
    let started = false
    frameGuard(win, () => (started = true))
    const pageSaw: unknown[] = []
    win.addEventListener("message", (event: any) => pageSaw.push(event.data))
    fromParent({ type: "ade-browser:hello", secret })
    expect(pageSaw).toEqual([])
    expect(started).toBe(false)
    expect(topPosted).toEqual([])
  })

  test("asks the pane for the secret, and keeps it from the page", () => {
    const { win, topPosted, fromParent } = makeWindow({ name: "ade-browser" })
    frameGuard(win, () => {})
    expect(topPosted).toEqual([{ type: "ade-browser:ask" }])

    const pageSaw: unknown[] = []
    win.addEventListener("message", (event: any) => pageSaw.push(event.data))
    win.addEventListener("message", (event: any) => pageSaw.push(event.data), true)
    fromParent({ type: "ade-browser:hello", secret })
    expect(pageSaw).toEqual([])
    // Other messages still reach the page.
    fromParent({ type: "visual-editor:set-mode", mode: "edit" })
    expect(pageSaw).toHaveLength(2)
  })

  test("the bridge speaks only in envelopes, and what it said early is not lost", () => {
    const { win, topPosted, fromParent } = makeWindow({ name: "ade-browser" })
    let shim: any
    frameGuard(win, (given) => {
      shim = given
      given.parent.postMessage({ type: "visual-editor:ready" }, "*")
    })
    expect(shim).toBeUndefined()
    fromParent({ type: "ade-browser:hello", secret })
    expect(topPosted.slice(1)).toEqual([
      { type: FRAME_ENVELOPE, secret, message: { type: "visual-editor:ready" } },
    ])
    expect(shim.__NIKCLI_INSPECTOR_ACTIVE__).toBe(false)
    // The page's own copy of the bridge stays out.
    expect(win.__NIKCLI_INSPECTOR_ACTIVE__).toBe(true)
  })

  test("the first secret stays; a second hello and a page's hello are ignored", () => {
    const { win, topPosted, fromParent, fromPage } = makeWindow({ name: "ade-browser" })
    let starts = 0
    let shim: any
    frameGuard(win, (given) => {
      starts++
      shim = given
    })
    fromPage({ type: "ade-browser:hello", secret: "page-chosen-secret-000" })
    expect(starts).toBe(0)
    fromParent({ type: "ade-browser:hello", secret })
    fromParent({ type: "ade-browser:hello", secret: "another-secret-00000000" })
    expect(starts).toBe(1)
    shim.parent.postMessage({ type: "visual-editor:dom-changed" })
    expect(topPosted.at(-1)).toEqual({ type: FRAME_ENVELOPE, secret, message: { type: "visual-editor:dom-changed" } })
  })

  test("the bridge hears the pane, not the page", () => {
    const { win, fromParent, fromPage } = makeWindow({ name: "ade-browser" })
    const heard: unknown[] = []
    frameGuard(win, (shim) => shim.addEventListener("message", (event: any) => heard.push(event.data)))
    fromParent({ type: "ade-browser:hello", secret })
    fromPage({ type: "visual-editor:set-mode", mode: "edit" })
    fromParent({ type: "visual-editor:set-mode", mode: "edit" })
    expect(heard).toEqual([{ type: "visual-editor:set-mode", mode: "edit" }])
  })
})

describe("openEnvelope", () => {
  const secret = newFrameSecret()

  test("opens only an envelope with the pane's secret", () => {
    const message = { type: "visual-editor:ready" }
    expect(openEnvelope({ type: FRAME_ENVELOPE, secret, message }, secret)).toEqual(message)
    expect(openEnvelope({ type: FRAME_ENVELOPE, secret: "guess", message }, secret)).toBeUndefined()
    expect(openEnvelope({ type: FRAME_ENVELOPE, message }, secret)).toBeUndefined()
    expect(openEnvelope(message, secret)).toBeUndefined()
    expect(openEnvelope(null, secret)).toBeUndefined()
    expect(openEnvelope("visual-editor:ready", secret)).toBeUndefined()
  })

  test("an empty or short secret opens nothing", () => {
    expect(openEnvelope({ type: FRAME_ENVELOPE, secret: "", message: 1 }, "")).toBeUndefined()
  })

  test("secrets are long and different", () => {
    expect(secret).toMatch(/^[0-9a-f]{36}$/)
    expect(newFrameSecret()).not.toBe(secret)
  })
})
