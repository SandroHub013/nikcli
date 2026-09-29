import { describe, expect, it } from "bun:test"
import { readFileSync, readdirSync, statSync } from "node:fs"
import path from "node:path"
import * as prompts from "@clack/prompts"

/**
 * EOT-18 requirement 12: "Headless mode never silently picks 'yes'."
 *
 * The finding this file pins came from auditing the *real* interactive surface
 * rather than the one the spec named. `specs/effect-tui/18-cli-command-architecture.md`
 * says requirement 12's remaining work is to "route `cli/effect/prompt.ts`
 * through `isHeadless`". That module has **zero importers** — `cli/effect/`
 * contains only that file, and nothing in `src`, `test`, or `script` imports
 * it. Guarding it would have been a guard on dead code, which is the same
 * finding class as the dead `Lifecycle<T>` wrapper this same spec removed.
 *
 * The surface that is actually live is 25 handler modules that import
 * `@clack/prompts` directly. 24 of them guard the cancel symbol. One did not,
 * and the guard it was missing is the one that decides whether `nikcli upgrade`
 * replaces the user's binary.
 */

const HANDLERS = path.resolve(import.meta.dirname, "../../src/cli/handlers")

/** Recursively collect every `.ts` file under a directory. */
function sources(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...sources(full))
    else if (entry.endsWith(".ts")) out.push(full)
  }
  return out
}

const INTERACTIVE = /prompts\.(select|text|password|confirm|multiselect)\s*[({]/

describe("clack cancel semantics", () => {
  it("a cancelled prompt is a truthy symbol, so a bare `!answer` guard never fires", () => {
    // This is the whole defect in one assertion, and it is asserted rather than
    // simulated because clack cannot be driven without a TTY: its
    // `createInterface` throws on a non-TTY stdin. That is the same reason the
    // missing guard survived review — the prompt is invisible to `bun test`.
    //
    // What `@clack/core` does, verified in
    // `node_modules/@clack/core/dist/index.mjs`:
    //   cancelSymbol = Symbol("clack:cancel")
    //   isCancel(x)  { return x === cancelSymbol }
    //
    // So a cancelled prompt answers with a **Symbol**, and every symbol is
    // truthy. A handler written as `if (!answer) return` does not return; it
    // falls through and treats "the user pressed Escape" as the affirmative.
    const cancelled: unknown = Symbol("clack:cancel")

    expect(typeof cancelled).toBe("symbol")
    expect(Boolean(cancelled)).toBe(true)
    // The guard as it was written, evaluated against a cancel.
    expect(!cancelled).toBe(false)
    // And the guard as fixed: it consults the predicate rather than truthiness.
    // `isCancel` is identity against clack's own symbol, so the caller's symbol
    // above is a stand-in; what is pinned is the shape of the correct guard.
    expect(prompts.isCancel(false)).toBe(false)
    expect(!false).toBe(true)
  })
})

describe("every interactive CLI prompt fails closed on cancel", () => {
  const files = sources(HANDLERS)
  const offenders: string[] = []

  for (const file of files) {
    const body = readFileSync(file, "utf8")
    if (!INTERACTIVE.test(body)) continue
    if (!/isCancel/.test(body)) offenders.push(path.relative(HANDLERS, file))
  }

  it("finds the handler surface this file is about", () => {
    // The pin below only means something if it is looking at a real population.
    // If a refactor moves every prompt behind a wrapper this count collapses
    // and the gate is measuring nothing.
    const prompting = files.filter((f) => INTERACTIVE.test(readFileSync(f, "utf8")))
    expect(prompting.length).toBeGreaterThanOrEqual(20)
  })

  it("no module calls an interactive prompt without checking isCancel", () => {
    // `nikcli upgrade` was the live instance: it asked "Install anyways?" with
    // `initialValue: false` and guarded only `if (!install)`, so pressing Esc —
    // or running with no TTY at all — skipped the guard and installed over a
    // package-manager-owned binary. The user asked it not to.
    expect(offenders).toEqual([])
  })

  it("guards the upgrade prompt that was the live defect", () => {
    // Named individually so the regression reports where it happened rather
    // than only as a count in a list.
    const upgrade = readFileSync(path.join(HANDLERS, "upgrade.ts"), "utf8")
    expect(upgrade).toMatch(/prompts\.isCancel\(install\)/)
  })
})
