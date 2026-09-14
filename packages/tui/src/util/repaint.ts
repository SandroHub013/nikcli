import type { CliRenderer } from "@opentui/core"
import { shouldForceOverlayRepaint } from "@nikcli-ai/util/win32"

/**
 * The renderer's own full-repaint switch.
 *
 * OpenTUI sets it for a resize, a resume, or a capability response, and
 * declares it private — hence the name rather than a type.
 */
const REPAINT_FLAG = "forceFullRepaintRequested"

/**
 * Make the next frame write every cell instead of only the changed ones.
 *
 * OpenTUI keeps a model of what each terminal cell holds and writes only the
 * diff. That is correct while every byte it writes arrives — on Windows it does
 * not: the console pipe loses part of a large frame (the reason
 * `shouldUseRendererThread` turns the output thread off there). The renderer
 * then believes the terminal shows cells it never received, and because those
 * cells match its model it never writes them again. Today a resize is the only
 * thing that repairs the screen, because a resize forces a full repaint.
 *
 * The flag is not part of the public API, so this stays a guarded poke: if a
 * future OpenTUI renames it, the call degrades to a plain render request
 * instead of throwing.
 */
export function forceFullRepaint(renderer: CliRenderer | undefined): boolean {
  if (!renderer) return false
  const repaintable = REPAINT_FLAG in renderer
  if (repaintable) Reflect.set(renderer, REPAINT_FLAG, true)
  renderer.requestRender()
  return repaintable
}

/**
 * Repaint once an overlay has settled, on the platforms that need it.
 *
 * Returns a cancel function for `onCleanup`: a dialog that closes before the
 * timer fires must not drag a repaint into whatever replaced it.
 */
export function scheduleOverlayRepaint(renderer: CliRenderer | undefined, delayMs = 200): () => void {
  if (!shouldForceOverlayRepaint()) return () => {}
  const timer = setTimeout(() => forceFullRepaint(renderer), delayMs)
  return () => clearTimeout(timer)
}
