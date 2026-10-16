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
      const sceneContainer = container.querySelector('[data-slot="splash-scene-container"]')
      expect(sceneContainer).not.toBeNull()
      const statusEl = sceneContainer?.querySelector('[data-slot="splash-status"]')
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
})
