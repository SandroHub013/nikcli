import { describe, expect, test } from "bun:test"
import { compileSolidJsx } from "../test-support/solid-jsx"

compileSolidJsx()
const { createComponent, createRoot } = await import("solid-js")
const { render } = await import("solid-js/web")
const { Splash } = await import("./splash")
const { SPLASH_SCENE_DELAY_MS } = await import("./timing")

describe("splash delayed loading and graceful fallback (Passo 4)", () => {
  const mountSplash = (props: { visible: boolean; status?: string; onDismiss?: () => void }) => {
    const container = document.createElement("div")
    document.body.appendChild(container)
    let disposeFn: (() => void) | undefined
    createRoot((dispose) => {
      disposeFn = () => {
        dispose()
        container.remove()
      }
      render(() => createComponent(Splash, props), container)
    })
    return {
      container,
      dispose: () => disposeFn?.(),
    }
  }

  test("delay constant SPLASH_SCENE_DELAY_MS is exactly 300 ms", () => {
    expect(SPLASH_SCENE_DELAY_MS).toBe(300)
  })

  test("before SPLASH_SCENE_DELAY_MS (t=0), stage is hidden and status is visible", () => {
    const { container, dispose } = mountSplash({ visible: true, status: "Apro il progetto..." })
    try {
      const stage = container.querySelector<HTMLElement>('[data-slot="splash-stage"]')
      expect(stage).not.toBeNull()
      // Stage must not have data-loaded before delay
      expect(stage?.hasAttribute("data-loaded")).toBe(false)

      const status = container.querySelector<HTMLElement>('[data-slot="splash-status"]')
      expect(status).not.toBeNull()
      expect(status?.textContent).toContain("Apro il progetto...")

      // Image element is not mounted yet
      const img = container.querySelector('[data-slot="splash-image"]')
      expect(img).toBeNull()
    } finally {
      dispose()
    }
  })

  test("after delay elapses, stage receives data-loaded and mounts image and canvas", async () => {
    const { container, dispose } = mountSplash({ visible: true, status: "Carico estensioni..." })
    try {
      await new Promise((r) => setTimeout(r, SPLASH_SCENE_DELAY_MS + 60))

      const stage = container.querySelector<HTMLElement>('[data-slot="splash-stage"]')
      expect(stage?.hasAttribute("data-loaded")).toBe(true)

      const img = container.querySelector<HTMLImageElement>('[data-slot="splash-image"]')
      expect(img).not.toBeNull()

      const canvas = container.querySelector<HTMLCanvasElement>('[data-slot="splash-canvas"]')
      expect(canvas).not.toBeNull()
    } finally {
      dispose()
    }
  })

  test("graceful fallback: if image decode throws, splash maintains background and status without console errors", async () => {
    const origDecode = Image.prototype.decode
    let consoleErrorCount = 0
    const origConsoleError = console.error
    console.error = () => {
      consoleErrorCount++
    }

    try {
      Image.prototype.decode = () => Promise.reject(new Error("Network image decode error"))

      const { container, dispose } = mountSplash({ visible: true, status: "In attesa..." })
      try {
        await new Promise((r) => setTimeout(r, SPLASH_SCENE_DELAY_MS + 60))

        const splash = container.querySelector('[data-component="ade-splash"]')
        expect(splash).not.toBeNull()

        const status = container.querySelector('[data-slot="splash-status"]')
        expect(status?.textContent).toContain("In attesa...")

        // No uncaught console errors
        expect(consoleErrorCount).toBe(0)
      } finally {
        dispose()
      }
    } finally {
      Image.prototype.decode = origDecode
      console.error = origConsoleError
    }
  })
})
