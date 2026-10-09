/**
 * `<ragu_latex>` — the Solid intrinsic wrapping {@link LatexRenderable}.
 *
 * The element name is prefixed for the same reason `<ragu_background>` is:
 * `extend()` writes into one process-wide catalogue shared with plugins, and
 * a bare `latex` would be the kind of name a plugin might reasonably claim.
 *
 * Registration runs on import rather than behind a call, so a component only
 * has to import the module it already needs. Re-registering is harmless.
 */
import { extend } from "@opentui/solid"
import { LatexRenderable } from "./renderable"

declare module "@opentui/solid" {
  interface OpenTUIComponents {
    ragu_latex: typeof LatexRenderable
  }
}

extend({ ragu_latex: LatexRenderable })

export * from "./index"
