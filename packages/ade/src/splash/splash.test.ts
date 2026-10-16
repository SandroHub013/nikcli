import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { compileSolidJsx } from "../test-support/solid-jsx"

compileSolidJsx()
const { createComponent, createRoot, createSignal } = await import("solid-js")
const { render } = await import("solid-js/web")
const { Splash } = await import("./splash")
const { calculateIntegerScale } = await import("./scene")

describe("splash component (step 3)", () => {
  let container: HTMLDivElement

  beforeEach(() => {
    container = document.createElement("div")
    document.body.appendChild(container)
  })

  afterEach(() => {
    container.remove()
    document.body.innerHTML = ""
    document.body.removeAttribute("style")
    document.documentElement.removeAttribute("style")
  })

  function mountSplash(props: { visible: boolean; status?: string; onDismiss?: () => void }) {
    let disposeFn: (() => void) | undefined
    createRoot((dispose) => {
      disposeFn = dispose
      render(() => createComponent(Splash, props), container)
    })
    return {
      dispose: () => disposeFn?.(),
    }
  }

  test("splash has fixed ink background and dark color-scheme without theme tokens (P1-1)", () => {
    const css = readFileSync(join(import.meta.dir, "splash.css"), "utf8")
    expect(css).not.toContain("var(--ade-bg")
    expect(css).not.toContain("var(--ade-text-weak")
    expect(css).toMatch(/color-scheme:\s*dark/)
    expect(css).toMatch(/background:\s*#120d0b/)
  })

  test("status is placed inside scene container and stays within innerHeight across viewports (P1-2)", () => {
    // 1. Structural check: status is a child of the scene container under canvas
    const handle = mountSplash({ visible: true, status: "Caricamento estensioni..." })
    try {
      const sceneContainer = container.querySelector<HTMLElement>('[data-slot="splash-scene-container"]')
      expect(sceneContainer).not.toBeNull()
      const statusEl = sceneContainer?.querySelector<HTMLElement>('[data-slot="splash-status"]')
      expect(statusEl).not.toBeNull()
      expect(statusEl?.parentElement).toBe(sceneContainer)
    } finally {
      handle.dispose()
    }

    // 2. CSS check: status has position absolute and row 76 positioning (top: calc(76 / 90 * 100%))
    const css = readFileSync(join(import.meta.dir, "splash.css"), "utf8")
    expect(css).toMatch(/\[data-slot="splash-status"\]\s*\{[^}]*position:\s*absolute;/)
    expect(css).toMatch(/\[data-slot="splash-status"\]\s*\{[^}]*top:\s*calc\(76\s*\/\s*90\s*\*\s*100%\);/)

    // 3. Viewport containment: verify status bottom stays within innerHeight for 1366x720, 1920x1080, 1536x826, 1280x720
    const viewports = [
      { w: 1366, h: 720 },
      { w: 1920, h: 1080 },
      { w: 1536, h: 826 },
      { w: 1280, h: 720 },
    ]

    for (const { w, h } of viewports) {
      const scale = calculateIntegerScale(w, h)
      const canvasHeight = 90 * scale
      const canvasTop = (h - canvasHeight) / 2
      const statusTop = canvasTop + (76 / 90) * canvasHeight // row 76
      const statusNominalHeight = 16
      const statusBottom = statusTop + statusNominalHeight
      expect(statusBottom).toBeLessThanOrEqual(h)
      // Also verify it sits 3 logical pixels below wordmark (which ends at row 73)
      const wordmarkBottom = canvasTop + 73 * scale
      expect(statusTop - wordmarkBottom).toBe(3 * scale)
    }
  })

  test("renders dialog with accessibility attributes and canvas", () => {
    const handle = mountSplash({ visible: true })
    try {
      const splash = container.querySelector('[data-component="ade-splash"]')
      expect(splash).not.toBeNull()
      expect(splash?.getAttribute("role")).toBe("dialog")
      expect(splash?.getAttribute("aria-modal")).toBe("true")
      expect(splash?.getAttribute("aria-label")).toBeTruthy()

      const canvas = container.querySelector('[data-slot="splash-canvas"]')
      expect(canvas).not.toBeNull()
    } finally {
      handle.dispose()
    }
  })

  test("renders status text when provided", () => {
    const handle = mountSplash({ visible: true, status: "Caricamento modelli..." })
    try {
      const statusEl = container.querySelector('[data-slot="splash-status"]')
      expect(statusEl).not.toBeNull()
      expect(statusEl?.textContent).toBe("Caricamento modelli...")
    } finally {
      handle.dispose()
    }
  })

  test("clicking the splash invokes onDismiss while visible", () => {
    let dismissed = false
    const handle = mountSplash({ visible: true, onDismiss: () => { dismissed = true } })
    try {
      const splash = container.querySelector('[data-component="ade-splash"]') as HTMLElement
      splash.click()
      expect(dismissed).toBe(true)
    } finally {
      handle.dispose()
    }
  })

  test("pressing Escape, Enter, or Space triggers onDismiss", () => {
    let dismissedCount = 0
    const handle = mountSplash({ visible: true, onDismiss: () => { dismissedCount++ } })
    try {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))
      expect(dismissedCount).toBe(1)

      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }))
      expect(dismissedCount).toBe(2)

      window.dispatchEvent(new KeyboardEvent("keydown", { key: " " }))
      expect(dismissedCount).toBe(3)

      // Other keys do not dismiss
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }))
      expect(dismissedCount).toBe(3)
    } finally {
      handle.dispose()
    }
  })

  test("sets data-leaving when visible flips to false, and unmounts after fade", async () => {
    let setVisibleSignal!: (v: boolean) => void
    let disposeFn: (() => void) | undefined

    createRoot((dispose) => {
      disposeFn = dispose
      const [visible, setVisible] = createSignal(true)
      setVisibleSignal = setVisible
      render(() => createComponent(Splash, { get visible() { return visible() } }), container)
    })

    try {
      const splash = container.querySelector('[data-component="ade-splash"]') as HTMLElement
      expect(splash.hasAttribute("data-leaving")).toBe(false)

      // Flip visible to false
      setVisibleSignal(false)

      // Immediately gets data-leaving attribute
      expect(splash.hasAttribute("data-leaving")).toBe(true)

      // After 650ms (FADE_MS = 600ms), it is unmounted from DOM
      await new Promise((resolve) => setTimeout(resolve, 650))
      expect(container.querySelector('[data-component="ade-splash"]')).toBeNull()
    } finally {
      disposeFn?.()
    }
  })

  test("dismiss during fade-out does not trigger onDismiss", () => {
    let dismissed = false
    let setVisibleSignal!: (v: boolean) => void
    let disposeFn: (() => void) | undefined

    createRoot((dispose) => {
      disposeFn = dispose
      const [visible, setVisible] = createSignal(true)
      setVisibleSignal = setVisible
      render(
        () => createComponent(Splash, {
          get visible() { return visible() },
          onDismiss: () => { dismissed = true },
        }),
        container,
      )
    })

    try {
      setVisibleSignal(false)

      const splash = container.querySelector('[data-component="ade-splash"]') as HTMLElement
      splash.click()
      expect(dismissed).toBe(false)

      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))
      expect(dismissed).toBe(false)
    } finally {
      disposeFn?.()
    }
  })

  test("complete lifecycle with mock timers and rAF queue (P2-3)", () => {
    let currentTime = 1000
    let nextTimerId = 1
    let timers: { id: number; due: number; cb: () => void }[] = []
    const rafs = new Map<number, FrameRequestCallback>()
    let nextRafId = 1

    const listeners = {
      keydown: 0,
      resize: 0,
      visibilitychange: 0,
    }

    const origSetTimeout = globalThis.setTimeout
    const origClearTimeout = globalThis.clearTimeout
    const origRAF = window.requestAnimationFrame
    const origCancelRAF = window.cancelAnimationFrame
    const origWinAdd = window.addEventListener
    const origWinRemove = window.removeEventListener
    const origDocAdd = document.addEventListener
    const origDocRemove = document.removeEventListener
    const origPerfNow = performance.now
    const origMatchMedia = window.matchMedia

    performance.now = () => currentTime

    globalThis.setTimeout = ((cb: any, ms: number = 0) => {
      const id = nextTimerId++
      timers.push({ id, due: currentTime + ms, cb })
      return id as any
    }) as any

    globalThis.clearTimeout = ((id: any) => {
      timers = timers.filter((t) => t.id !== id)
    }) as any

    window.requestAnimationFrame = (cb: FrameRequestCallback) => {
      const id = nextRafId++
      rafs.set(id, cb)
      return id
    }

    window.cancelAnimationFrame = (id: number) => {
      rafs.delete(id)
    }

    window.addEventListener = (event: string, cb: any, opts?: any) => {
      if (event === "keydown") listeners.keydown++
      if (event === "resize") listeners.resize++
      return origWinAdd.call(window, event, cb, opts)
    }

    window.removeEventListener = (event: string, cb: any, opts?: any) => {
      if (event === "keydown") listeners.keydown--
      if (event === "resize") listeners.resize--
      return origWinRemove.call(window, event, cb, opts)
    }

    document.addEventListener = (event: string, cb: any, opts?: any) => {
      if (event === "visibilitychange") listeners.visibilitychange++
      return origDocAdd.call(document, event, cb, opts)
    }

    document.removeEventListener = (event: string, cb: any, opts?: any) => {
      if (event === "visibilitychange") listeners.visibilitychange--
      return origDocRemove.call(document, event, cb, opts)
    }

    const advance = (ms: number) => {
      currentTime += ms
      let firedAny = true
      while (firedAny) {
        firedAny = false
        const dueTimers = timers.filter((t) => t.due <= currentTime)
        if (dueTimers.length > 0) {
          dueTimers.sort((a, b) => a.due - b.due)
          const t = dueTimers[0]!
          timers = timers.filter((x) => x.id !== t.id)
          t.cb()
          firedAny = true
        }
      }
    }

    const runRaf = () => {
      const currentRafs = Array.from(rafs.entries())
      rafs.clear()
      for (const [_, cb] of currentRafs) {
        cb(currentTime)
      }
    }

    let disposeRoot: (() => void) | undefined

    try {
      let setVisibleSignal!: (v: boolean) => void
      createRoot((dispose) => {
        disposeRoot = dispose
        const [visible, setVisible] = createSignal(true)
        setVisibleSignal = setVisible
        render(() => createComponent(Splash, { get visible() { return visible() } }), container)
      })

      // 1. Advance 299 ms: scene delay is 300 ms, so 0 rAF queued
      advance(299)
      expect(rafs.size).toBe(0)

      // 2. Advance 1 ms (at 300 ms): scene starts, exactly 1 rAF queued
      advance(1)
      expect(rafs.size).toBe(1)

      // Tick rAF: keeps 1 rAF in queue
      runRaf()
      expect(rafs.size).toBe(1)

      // 3. Set visible to false: animation loop stops immediately at the start of fade (P3-8)
      setVisibleSignal(false)
      expect(rafs.size).toBe(0)
      advance(600)

      // All cleaned up: 0 rAF in queue, 0 timers, listeners balanced
      expect(rafs.size).toBe(0)
      expect(timers.length).toBe(0)
      expect(listeners.keydown).toBe(0)
      expect(listeners.resize).toBe(0)
      expect(listeners.visibilitychange).toBe(0)

      // 4. Remount during fade: true -> false -> true
      setVisibleSignal(true)
      advance(300)
      expect(rafs.size).toBe(1)

      setVisibleSignal(false)
      advance(200) // 200ms into fade
      setVisibleSignal(true) // aborted fade, re-activated
      expect(rafs.size).toBeLessThanOrEqual(1)

      // 5. prefersReducedMotion via matchMedia: 0 rAF
      window.matchMedia = (query: string) => ({
        matches: query.includes("prefers-reduced-motion: reduce"),
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as any

      // Unmount previous
      setVisibleSignal(false)
      advance(600)
      expect(rafs.size).toBe(0)

      // Mount again with reduced motion active
      setVisibleSignal(true)
      advance(350)
      expect(rafs.size).toBe(0) // static frame rendered, 0 rAF
    } finally {
      disposeRoot?.()
      globalThis.setTimeout = origSetTimeout
      globalThis.clearTimeout = origClearTimeout
      window.requestAnimationFrame = origRAF
      window.cancelAnimationFrame = origCancelRAF
      window.addEventListener = origWinAdd
      window.removeEventListener = origWinRemove
      document.addEventListener = origDocAdd
      document.removeEventListener = origDocRemove
      performance.now = origPerfNow
      window.matchMedia = origMatchMedia
    }
  })

  test("dynamically responds to prefers-reduced-motion media query changes (P3-1, P3-10)", () => {
    let currentTime = 1000
    let nextTimerId = 1
    let timers: { id: number; due: number; cb: () => void }[] = []
    const rafs = new Map<number, FrameRequestCallback>()
    let nextRafId = 1

    let changeHandler: ((e: any) => void) | undefined
    const mockMql = {
      matches: false,
      media: "(prefers-reduced-motion: reduce)",
      addEventListener: (evt: string, fn: any) => {
        if (evt === "change") changeHandler = fn
      },
      removeEventListener: (evt: string, fn: any) => {
        if (evt === "change" && changeHandler === fn) changeHandler = undefined
      },
    }

    const origSetTimeout = globalThis.setTimeout
    const origClearTimeout = globalThis.clearTimeout
    const origRAF = window.requestAnimationFrame
    const origCancelRAF = window.cancelAnimationFrame
    const origPerfNow = performance.now
    const origMatchMedia = window.matchMedia

    performance.now = () => currentTime
    globalThis.setTimeout = ((cb: any, ms: number = 0) => {
      const id = nextTimerId++
      timers.push({ id, due: currentTime + ms, cb })
      return id as any
    }) as any
    globalThis.clearTimeout = ((id: any) => {
      timers = timers.filter((t) => t.id !== id)
    }) as any
    window.requestAnimationFrame = (cb: FrameRequestCallback) => {
      const id = nextRafId++
      rafs.set(id, cb)
      return id
    }
    window.cancelAnimationFrame = (id: number) => {
      rafs.delete(id)
    }
    window.matchMedia = ((query: string) => {
      if (query.includes("prefers-reduced-motion")) return mockMql as any
      return { matches: false, addEventListener: () => {}, removeEventListener: () => {} } as any
    }) as any

    const advance = (ms: number) => {
      currentTime += ms
      let firedAny = true
      while (firedAny) {
        firedAny = false
        const dueTimers = timers.filter((t) => t.due <= currentTime)
        if (dueTimers.length > 0) {
          dueTimers.sort((a, b) => a.due - b.due)
          const t = dueTimers[0]!
          timers = timers.filter((x) => x.id !== t.id)
          t.cb()
          firedAny = true
        }
      }
    }

    // Case A: reduce changes BEFORE 300ms delay -> builds 0 scenes early, 1 static scene at 300ms
    const handleA = mountSplash({ visible: true })
    try {
      expect(typeof changeHandler).toBe("function")
      advance(150)
      expect(rafs.size).toBe(0)

      mockMql.matches = true
      changeHandler!({ matches: true })
      expect(rafs.size).toBe(0)

      advance(150) // reaches 300ms delay
      expect(rafs.size).toBe(0) // static scene, 0 rAF
    } finally {
      handleA.dispose()
    }

    // Case B: reduce changes AFTER 300ms while loop is actively running
    mockMql.matches = false
    timers = []
    rafs.clear()
    const handleB = mountSplash({ visible: true })
    try {
      advance(300)
      expect(rafs.size).toBe(1) // loop active

      mockMql.matches = true
      changeHandler!({ matches: true })
      expect(rafs.size).toBe(0) // loop stopped immediately

      advance(200)
      expect(rafs.size).toBe(0)
    } finally {
      handleB.dispose()
      globalThis.setTimeout = origSetTimeout
      globalThis.clearTimeout = origClearTimeout
      window.requestAnimationFrame = origRAF
      window.cancelAnimationFrame = origCancelRAF
      performance.now = origPerfNow
      window.matchMedia = origMatchMedia
    }
  })
})
