import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { resolvePaneState, STATE_SHORT } from "./pane-state"

/*
 * A suspended session (P1-C6) looks like what it is: nothing running. Verifiche
 * found it saying «Permesso · Sospesa» with the shield blinking for ever (the
 * GPU went from 0.3 to 1.8%).
 */

test("the header says «Sospesa», not «Permesso», though its one button is Riprendi", () => {
  expect(resolvePaneState({ status: "idle", activity: "suspended", hasActions: true })).toBe("off")
  expect(STATE_SHORT.off).toBe("Sospesa")
  // Restored from disk, the pane may carry an older status: still suspended.
  expect(resolvePaneState({ status: "done", activity: "suspended", hasActions: true })).toBe("off")
})

test("the suspended state's icon does not move", () => {
  const css = readFileSync(join(import.meta.dir, "pane.css"), "utf-8")
  const rules = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter(([, selector]) => /\.ic-off\b/.test(selector!))
  for (const [, , body] of rules) expect(body).not.toMatch(/animation/)
})
