import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { compileSolidJsx } from "../test-support/solid-jsx"

compileSolidJsx()
const { createComponent, createRoot, createSignal } = await import("solid-js")
const { render } = await import("solid-js/web")
const { Splash } = await import("./splash")

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
