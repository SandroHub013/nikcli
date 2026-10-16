import { Show, createEffect, createSignal, onCleanup, onMount } from "solid-js"
import { t } from "../i18n"
import { startPixelScene, type SceneController } from "./scene"
import "./splash.css"
import { SPLASH_SCENE_DELAY_MS, sceneIsWorthBuilding } from "./timing"

export interface SplashProps {
  /** Hidden when this goes false. The fade is handled here. */
  visible: boolean
  /** What it says it is doing, under the scene. */
  status?: string
  /** Optional callback to dismiss or skip the splash early. */
  onDismiss?: () => void
}

const FADE_MS = 600

/**
 * ADE Splash Screen: Pixel-Art Cooking Scene ("Ragù Code").
 *
 * Left: Developer stirring, tasting, and thumbs-up in an 8-pose cycle.
 * Center: Canonical Ragu cooking pot boiling, steaming, and lid-bobbing at 8fps.
 * Right: Laptop with ADE code display.
 * Bottom: Colored "Ragù Code" pixel wordmark with grave accent on ù.
 *
 * Canvas-based rendering with integer pixelated scaling across 800px to 4K displays.
 * Respects prefers-reduced-motion with a single static frame (no animation loop).
 *
 * The workbench keeps this component mounted for the whole session and only
 * flips `visible`. The scene belongs to `SplashView`, which exists exactly as long
 * as the `<Show>` does. When the fade ends the view unmounts, cleaning up the loop
 * and event listeners cleanly.
 */
export function Splash(props: SplashProps) {
  const [gone, setGone] = createSignal(false)

  // Fade out smoothly when props.visible flips to false
  createEffect(() => {
    if (!props.visible) {
      const timer = setTimeout(() => setGone(true), FADE_MS)
      onCleanup(() => clearTimeout(timer))
    } else {
      setGone(false)
    }
  })

  return (
    <Show when={!gone()}>
      <SplashView visible={props.visible} status={props.status} onDismiss={props.onDismiss} />
    </Show>
  )
}

function SplashView(props: { visible: boolean; status?: string; onDismiss?: () => void }) {
  let canvasRef: HTMLCanvasElement | undefined

  const dismiss = () => {
    if (props.visible) props.onDismiss?.()
  }

  onMount(() => {
    const canvas = canvasRef
    if (!canvas) return
    const appearedAt = performance.now()

    let controller: SceneController | undefined
    let disposed = false

    onCleanup(() => {
      disposed = true
      controller?.stop()
    })

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
        dismiss()
      }
    }
    window.addEventListener("keydown", handleKeyDown)
    onCleanup(() => window.removeEventListener("keydown", handleKeyDown))

    const handleResize = () => {
      const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1
      controller?.resize(window.innerWidth, window.innerHeight, dpr)
    }
    window.addEventListener("resize", handleResize)
    onCleanup(() => window.removeEventListener("resize", handleResize))

    let dprMediaQuery: MediaQueryList | undefined
    let handleDprChange: (() => void) | undefined

    const setupDprListener = () => {
      if (typeof window === "undefined" || typeof window.matchMedia !== "function") return
      if (dprMediaQuery && handleDprChange) {
        dprMediaQuery.removeEventListener?.("change", handleDprChange)
      }
      const dpr = window.devicePixelRatio || 1
      dprMediaQuery = window.matchMedia(`(resolution: ${dpr}dppx)`)
      handleDprChange = () => {
        handleResize()
        setupDprListener()
      }
      dprMediaQuery.addEventListener?.("change", handleDprChange)
    }
    setupDprListener()
    onCleanup(() => {
      if (dprMediaQuery && handleDprChange) {
        dprMediaQuery.removeEventListener?.("change", handleDprChange)
      }
    })

    const prefersReducedMotion =
      typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches

    // Start scene after delay; if boot completes before delay, scene is never built
    const starting = setTimeout(() => {
      if (disposed) return
      if (!sceneIsWorthBuilding(appearedAt, performance.now())) return

      controller = startPixelScene(canvas, { prefersReducedMotion })
      handleResize()
    }, SPLASH_SCENE_DELAY_MS)

    onCleanup(() => clearTimeout(starting))
  })

  return (
    <div
      data-component="ade-splash"
      data-slot="ade-splash-root"
      data-leaving={!props.visible ? "" : undefined}
      onClick={dismiss}
      role="dialog"
      aria-label={t("splash.aria")}
      aria-modal="true"
    >
      <div data-slot="splash-scene-container">
        <canvas ref={canvasRef} data-slot="splash-canvas" aria-hidden="true" />
        <Show when={props.status}>
          <div data-slot="splash-status" aria-live="polite">
            {props.status}
          </div>
        </Show>
      </div>

      {/* CRT Scanlines & Vignette */}
      <div data-slot="splash-crt" aria-hidden="true" />
    </div>
  )
}
