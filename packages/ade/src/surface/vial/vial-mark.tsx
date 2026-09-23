import { on, createEffect, onCleanup, onMount } from "solid-js"
import "./vial.css"
import type { ResolvedTheme } from "../../theme"
import { createVialLoop, type VialLoop, type VialView } from "./loop"
import { drawGlass, shadeLiquid } from "./paint"
import { vialFor, type VialFamily } from "./sim"

/*
 * The vial in the Design and Decisions buttons (S62): a glass tube whose
 * level says how many items wait. One loop for both, made when the first is
 * drawn; it sleeps while the window is hidden and settles every tube at once
 * when reduced motion is switched on.
 */

let shared: VialLoop | undefined
let reducedQuery: MediaQueryList | undefined

const reducedMotion = () => reducedQuery?.matches ?? false

function sharedLoop(): VialLoop {
  if (shared) return shared
  reducedQuery = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : undefined
  const loop = createVialLoop({
    raf: (callback) => requestAnimationFrame(callback),
    cancelRaf: (id) => cancelAnimationFrame(id),
    timeout: (callback, ms) => window.setTimeout(callback, ms),
    cancelTimeout: (id) => window.clearTimeout(id),
    hidden: () => document.hidden,
    reduced: reducedMotion,
  })
  document.addEventListener("visibilitychange", () => (document.hidden ? loop.sleep() : loop.wake()))
  reducedQuery?.addEventListener?.("change", () => loop.settle())
  shared = loop
  return loop
}

export function VialMark(props: { fam: VialFamily; count: number; theme: ResolvedTheme }) {
  let canvas: HTMLCanvasElement | undefined
  let ctx: CanvasRenderingContext2D | null = null
  let image: ImageData | undefined
  // Read once and on a resize: reading it every frame forces a layout per button.
  let box: [number, number] | undefined
  const loop = sharedLoop()
  const vial = vialFor(props.fam, props.count, reducedMotion())

  const view: VialView = {
    vial,
    paint: () => {
      if (!canvas || !ctx) return
      const dpr = devicePixelRatio || 1
      if (!box) box = [canvas.clientWidth, canvas.clientHeight]
      const w = Math.max(4, Math.round(box[0] * dpr))
      const h = Math.max(4, Math.round(box[1] * dpr))
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w
        canvas.height = h
        image = undefined
      }
      image ??= ctx.createImageData(w, h)
      image.data.fill(0)
      shadeLiquid(image.data, w, h, dpr, vial, props.theme)
      ctx.putImageData(image, 0, 0)
      drawGlass(ctx, w, h, dpr, vial, props.theme)
    },
  }

  onMount(() => {
    // Without Path2D (a test DOM) there is no glass to draw: the tube still keeps count.
    ctx = typeof Path2D === "function" ? (canvas?.getContext("2d") ?? null) : null
    const remeasure = () => {
      box = undefined
      view.force = true
      loop.wake()
    }
    window.addEventListener("resize", remeasure)
    const remove = loop.add(view)
    onCleanup(() => {
      window.removeEventListener("resize", remeasure)
      remove()
    })
  })

  createEffect(
    on(
      () => props.count,
      (count) => {
        vialFor(props.fam, count, reducedMotion())
        loop.wake()
      },
      { defer: true },
    ),
  )
  createEffect(
    on(
      () => props.theme,
      () => {
        view.force = true
        loop.wake()
      },
      { defer: true },
    ),
  )

  return <canvas ref={canvas} data-slot="vial" data-fam={props.fam} aria-hidden="true" />
}
