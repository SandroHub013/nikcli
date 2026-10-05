import { describe, expect, test } from "bun:test"
import type { CliRenderer } from "@opentui/core"
import { guardConsoleOverlay } from "@tui/app"

/**
 * A console overlay that cannot be built must not end the session.
 *
 * The renderer registers its own handler as a *process-level*
 * `uncaughtException` / `unhandledRejection` listener, and that handler opens
 * the console overlay so an error is readable. The overlay allocates a native
 * framebuffer; the native allocator has a fixed budget of live allocations
 * shared by every buffer, text buffer and node, and when that budget is spent
 * `createOptimizedBuffer` returns null and opentui throws
 * `Failed to create optimized buffer: 184xH`. Renderables survive that
 * (`Renderable.createFrameBuffer` catches it); the console did not, and a
 * throw inside an uncaught-exception handler is not recoverable — the terminal
 * died with `script "dev" exited with code 7` and took the session with it.
 *
 * So this is asserted against the module that installs the guard rather than
 * against a mounted app: the behaviour is a `try`, and the thing worth pinning
 * is that a failing overlay reports instead of propagating into the renderer.
 */
function rendererWhoseOverlayThrows(error: Error) {
  let opened = 0
  const renderer = {
    console: {
      show() {
        opened++
        throw error
      },
    },
  } as unknown as CliRenderer
  return { renderer, opened: () => opened }
}

describe("console overlay", () => {
  test("a framebuffer allocation failure is reported, not thrown at the caller", () => {
    const boom = new Error("Failed to create optimized buffer: 184x14")
    const h = rendererWhoseOverlayThrows(boom)

    guardConsoleOverlay(h.renderer)

    expect(() => h.renderer.console.show()).not.toThrow()
    // The attempt is still made: a working overlay must keep opening.
    expect(h.opened()).toBe(1)
  })

  test("a healthy overlay is untouched", () => {
    let opened = 0
    const renderer = {
      console: {
        show() {
          opened++
        },
      },
    } as unknown as CliRenderer

    guardConsoleOverlay(renderer)
    renderer.console.show()
    renderer.console.show()

    expect(opened).toBe(2)
  })

  test("a renderer without an overlay is not a reason to fail startup", () => {
    expect(() => guardConsoleOverlay({} as CliRenderer)).not.toThrow()
    expect(() => guardConsoleOverlay(undefined as unknown as CliRenderer)).not.toThrow()
  })
})
