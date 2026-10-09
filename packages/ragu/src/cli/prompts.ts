import * as clack from "@clack/prompts"
import { isHeadless } from "@/cli/headless"
import { UI } from "@/cli/ui"

/**
 * `@clack/prompts` for command handlers, with the headless rule applied once.
 *
 * clack reads its answer from stdin. With no terminal there is none to read, so
 * a prompt does not fail — it waits forever. EOT-18 requirement 12 says a prompt
 * with no default fails closed instead; the interactive ones are wrapped here
 * so that holds for every handler without each one repeating the check. Output
 * helpers (`intro`, `log`, `spinner`, ...) and `isCancel` are re-exported as-is,
 * and behaviour in a terminal is unchanged.
 */
export * from "@clack/prompts"

function guarded<Fn extends (opts: any) => Promise<unknown>>(fn: Fn): Fn {
  return ((opts: { message?: string }) => {
    if (isHeadless()) return Promise.reject(new UI.HeadlessFailure({ prompt: opts.message ?? "input" }))
    return fn(opts)
  }) as Fn
}

export const select = guarded(clack.select)
export const multiselect = guarded(clack.multiselect)
export const autocomplete = guarded(clack.autocomplete)
export const text = guarded(clack.text)
export const password = guarded(clack.password)
export const confirm = guarded(clack.confirm)
