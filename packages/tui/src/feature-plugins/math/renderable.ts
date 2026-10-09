/**
 * `<ragu_latex>` — the JSX binding for `@ragu/tui-math`'s renderable.
 *
 * The class itself lives in the package, which is deliberately renderer-
 * agnostic; the binding lives here, next to `ragu_background`, for the same
 * reason that one does: `extend()` writes into a process-wide catalogue that
 * the Solid reconciler reads, and the catalogue that must be written is
 * **ragu's own** `@opentui/solid`.
 *
 * The package ships a `./solid` entry that does this itself, and importing it
 * from here would resolve `@opentui/solid` from `packages/tui-math`, which
 * does not depend on it — it is an optional peer, so the import is
 * unresolvable and the registration would land in a different module instance
 * even if it were not.
 *
 * The prefix is not decoration: plugins share the catalogue, and a bare
 * `latex` is a name a plugin might reasonably claim.
 */
import { extend } from "@opentui/solid"
import { LatexRenderable } from "@ragu/tui-math/renderable"

declare module "@opentui/solid" {
  interface OpenTUIComponents {
    ragu_latex: typeof LatexRenderable
  }
}

extend({ ragu_latex: LatexRenderable })

export { LatexRenderable }
