/**
 * Desk badge — a small e-paper or framebuffer panel that shows what the
 * agent is working on, so the people around you know before they interrupt.
 *
 * The agent (or a mod on `turn.start`/`turn.complete`) calls the `gadget`
 * tool's `show` action with a tree; this gadget only draws. With a Waveshare
 * e-paper, replace `display.framebuffer` with a driver built on
 * `display.layout` and `display.rasterize` over the vendor's Python or C
 * library — the tree and the viewport stay the same.
 */
import { Gadget, display, button } from "@nikcli-ai/gadget"

export default new Gadget({
  name: "desk-badge",
  builtins: false,
  display: display.framebuffer({ device: "/dev/fb0", width: 480, height: 320, bytesPerPixel: 2, scale: 3 }),
  buttons: button.gpio({ pins: { next: 5, ok: 6 } }),
  onMessage(text) {
    console.error(`[badge] ${text}`)
  },
})
