import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { resolvePaneState, STATE_SHORT } from "./pane-state"

/*
 * A suspended session (P1-C6) looks like what it is: nothing running. Verifiche
 * found it saying «Permesso · Sospesa» with the shield blinking for ever (the
 * GPU went from 0.3 to 1.8%).
 *
 * The icon wears `ic-<state>` (pane.tsx), so the class a suspended pane carries
 * is whatever `resolvePaneState` answers, not a name spelled out here. The two
 * `lint:` below read the sheet, which is what the rule is about (TEAM.md, rule
 * 22): they say which selectors of the sheet animate a state icon, and the icon
 * of a state that must stay still is not one of them.
 */

const css = readFileSync(join(import.meta.dir, "pane.css"), "utf-8")

/** What a suspended session resolves to, and a closed one. */
const SUSPENDED = resolvePaneState({
  status: "idle",
  activity: "suspended",
  hasActions: true,
})
const CLOSED = resolvePaneState({
  status: "done",
  exited: true,
  hasActions: true,
})

/*
 * Motion lives in the sidebar only (DS-5, the user's choice of 2026-11-02): the
 * pane's chip and its icon do not move for any state, so a suspended or a
 * closed session cannot be the one that blinks. The sidebar's single breathing
 * is checked in `state-list.test.ts`.
 */

/**
 * Every selector in the sheet that could match a state icon and declares an
 * animation. `animation: none` is not one, and neither are the sweep and the
 * haloes: those hang off a pane's pseudo-elements, never off the icon.
 */
function animatedIconSelectors(sheet: string): string[] {
  return [...sheet.matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .filter(([, , body]) => /(^|[;\s])animation(?:-name)?\s*:(?!\s*none)/.test(body))
    .flatMap(([, selector]) => selector.split(",").map((one) => one.trim()))
    .filter((selector) => !selector.startsWith("@") && /(^|[\s>+~])\.ic\b/.test(selector))
}

test("the header says «Sospesa», not «Permesso», though its one button is Riprendi", () => {
  expect(SUSPENDED).toBe("off")
  expect(STATE_SHORT.off).toBe("Sospesa")
  // Restored from disk, the pane may carry an older status: still suspended.
  expect(
    resolvePaneState({
      status: "done",
      activity: "suspended",
      hasActions: true,
    }),
  ).toBe("off")
})

test("a session that ended well says «Chiusa», still, though its button is Riprendi", () => {
  expect(CLOSED).toBe("closed")
  expect(STATE_SHORT.closed).toBe("Chiusa")
  // A process still there keeps what it had: a prompt is a permission; one that failed is an error.
  expect(resolvePaneState({ status: "done", hasActions: true })).toBe("perm")
  expect(resolvePaneState({ status: "error", exited: true, hasActions: true })).toBe("err")
})

test("lint: the sheet animates no state icon at all", () => {
  expect(animatedIconSelectors(css)).toEqual([])
})

test("lint: the lint can see an animated icon (rule 22: an empty result must not pass by blindness)", () => {
  const sheet = [".ic-work { animation: spin 1s infinite }", ".ic-ask .d1 { animation: dot 1s }"].join(" ")
  expect(animatedIconSelectors(sheet)).toEqual([".ic-work", ".ic-ask .d1"])
  expect(animatedIconSelectors(".ic-work { animation: none }")).toEqual([])
})

test("lint: neither a suspended nor a closed session's icon is a selector the sheet animates", () => {
  for (const state of [SUSPENDED, CLOSED]) {
    const icon = `ic-${state}`
    for (const selector of animatedIconSelectors(css)) {
      expect([icon, selector, selector.includes(`.${icon}`)]).toEqual([icon, selector, false])
    }
  }
})
