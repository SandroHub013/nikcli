import { Show, createEffect, createSignal, onCleanup, onMount } from "solid-js"
import { t } from "../i18n"
import { layoutSceneContainer, startPixelScene, type SceneController } from "./scene"
import "./splash.css"
import { SPLASH_SCENE_DELAY_MS, sceneIsWorthBuilding } from "./timing"
import scenaUrl from "./art/scena.png"

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
 * ADE Splash Screen: Authentic Reference Cooking Scene ("Ragù Code").
 *
 * Full reference artwork (1672x941) displayed whole with an overlay transparent canvas
 * animating steam puffs, ragù bubbles with gravity, sparkles, eye blink, and blinking green cursor.
 *
 * Responsive layout scales cleanly across viewports from 800px to 4K displays.
 * Respects prefers-reduced-motion with the static image only (no animation loop).
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
  let stageRef: HTMLDivElement | undefined
  let canvasRef: HTMLCanvasElement | undefined
  let controller: SceneController | undefined
  let disposed = false
  let startingFired = false
  let restartScene: ((opts?: { prefersReducedMotion?: boolean }) => void) | undefined

  const [imageLoaded, setImageLoaded] = createSignal(false)

  // Retain last known status message so it does not vanish prematurely during fade-out
  const [displayedStatus, setDisplayedStatus] = createSignal(props.status)
  createEffect(() => {
    if (props.visible) {
      setDisplayedStatus(props.status)
    } else if (props.status) {
      setDisplayedStatus(props.status)
    }
  })

  const dismiss = () => {
    if (props.visible) props.onDismiss?.()
  }

  const handleResize = () => {
    if (controller) {
      controller.resize(window.innerWidth, window.innerHeight)
    } else if (canvasRef) {
      layoutSceneContainer(canvasRef, window.innerWidth, window.innerHeight)
    }
  }

  const getPrefersReducedMotion = () =>
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches

  let wasHidden = false
  // Stop animation loop immediately when props.visible flips to false (at the start of fade)
  createEffect(() => {
    if (!props.visible) {
      controller?.stop()
      wasHidden = true
    } else if (wasHidden && startingFired && imageLoaded()) {
      wasHidden = false
      restartScene?.({ prefersReducedMotion: getPrefersReducedMotion() })
    }
  })

  onCleanup(() => {
    disposed = true
    controller?.stop()
  })

  onMount(() => {
    const canvas = canvasRef
    if (!canvas) return
    canvas.width = 1672
    canvas.height = 941
    handleResize()
    const appearedAt = performance.now()

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
        dismiss()
      }
    }
    window.addEventListener("keydown", handleKeyDown)
    onCleanup(() => window.removeEventListener("keydown", handleKeyDown))

    window.addEventListener("resize", handleResize)
    onCleanup(() => window.removeEventListener("resize", handleResize))


    // Live listener for prefers-reduced-motion changes (P3-5: handles both reduce and turning back on)
    if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
      const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)")
      const handleMotionChange = (e: MediaQueryListEvent | MediaQueryList) => {
        if (startingFired && imageLoaded()) {
          restartScene?.({ prefersReducedMotion: e.matches })
        }
      }
      if (motionQuery.addEventListener) {
        motionQuery.addEventListener("change", handleMotionChange)
      } else if (motionQuery.addListener) {
        motionQuery.addListener(handleMotionChange)
      }
      onCleanup(() => {
        if (motionQuery.removeEventListener) {
          motionQuery.removeEventListener("change", handleMotionChange)
        } else if (motionQuery.removeListener) {
          motionQuery.removeListener(handleMotionChange)
        }
      })
    }

    // Start scene after delay; if boot completes before delay, scene is never built
    const starting = setTimeout(() => {
      startingFired = true
      if (disposed) return
      if (!props.visible) return
      if (!sceneIsWorthBuilding(appearedAt, performance.now())) return

      if (typeof Image !== "undefined") {
        try {
          const img = new Image()
          img.src = scenaUrl
          img.setAttribute("data-slot", "splash-image")
          img.draggable = false
          img.alt = ""

          const onReady = () => {
            if (disposed || !props.visible) return
            // P3-2: Insert decoded image element directly into DOM before data-loaded
            if (stageRef && !stageRef.querySelector('[data-slot="splash-image"]')) {
              stageRef.insertBefore(img, canvasRef!)
            }
            setImageLoaded(true)
            // P3-1: Animation cycle starts only after image is decoded and ready
            if (canvas) {
              controller?.stop()
              controller = startPixelScene(canvas, { prefersReducedMotion: getPrefersReducedMotion() })
              handleResize()
            }
          }

          if (img.decode) {
            img.decode().then(onReady).catch(() => {})
          } else {
            img.onload = onReady
            img.onerror = () => {}
          }
        } catch {
          // Graceful fallback: maintain background and status without console errors
        }
      } else {
        setImageLoaded(true)
        if (canvas) {
          controller?.stop()
          controller = startPixelScene(canvas, { prefersReducedMotion: getPrefersReducedMotion() })
          handleResize()
        }
      }
    }, SPLASH_SCENE_DELAY_MS)

    restartScene = (opts) => {
      if (!disposed && canvas && startingFired && imageLoaded()) {
        controller?.stop()
        controller = startPixelScene(canvas, opts)
        handleResize()
      }
    }

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
        <div ref={stageRef} data-slot="splash-stage" data-loaded={imageLoaded() ? "" : undefined}>
          <canvas
            ref={canvasRef}
            data-slot="splash-canvas"
            width={1672}
            height={941}
            aria-hidden="true"
          />
        </div>
        <Show when={displayedStatus()}>
          <div data-slot="splash-status" aria-live="polite">
            {displayedStatus()}
          </div>
        </Show>
      </div>
    </div>
  )
}
