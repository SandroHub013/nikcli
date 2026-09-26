import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolvePaneState, STATE_SHORT } from "./pane-state";

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

const css = readFileSync(join(import.meta.dir, "pane.css"), "utf-8");

/** What a suspended session resolves to, and a closed one. */
const SUSPENDED = resolvePaneState({
  status: "idle",
  activity: "suspended",
  hasActions: true,
});
const CLOSED = resolvePaneState({
  status: "done",
  exited: true,
  hasActions: true,
});

/** The three states whose icon is meant to move, and only those. */
const MAY_MOVE = [
  ".ic-work",
  ".ic-perm",
  ".ic-ask .d1",
  ".ic-ask .d2",
  ".ic-ask .d3",
];

/**
 * Every selector in the sheet that could match a state icon and declares an
 * animation. `animation: none` is not one, and neither are the sweep and the
 * haloes: those hang off a pane's pseudo-elements, never off the icon.
 */
function animatedIconSelectors(sheet: string): string[] {
  return [...sheet.matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .filter(([, , body]) =>
      /(^|[;\s])animation(?:-name)?\s*:\s*(?!none)/.test(body),
    )
    .flatMap(([, selector]) => selector.split(",").map((one) => one.trim()))
    .filter(
      (selector) =>
        !selector.startsWith("@") && /(^|[\s>+~])\.ic\b/.test(selector),
    );
}

test("the header says «Sospesa», not «Permesso», though its one button is Riprendi", () => {
  expect(SUSPENDED).toBe("off");
  expect(STATE_SHORT.off).toBe("Sospesa");
  // Restored from disk, the pane may carry an older status: still suspended.
  expect(
    resolvePaneState({
      status: "done",
      activity: "suspended",
      hasActions: true,
    }),
  ).toBe("off");
});

test("a session that ended well says «Chiusa», still, though its button is Riprendi", () => {
  expect(CLOSED).toBe("closed");
  expect(STATE_SHORT.closed).toBe("Chiusa");
  // A process still there keeps what it had: a prompt is a permission; one that failed is an error.
  expect(resolvePaneState({ status: "done", hasActions: true })).toBe("perm");
  expect(
    resolvePaneState({ status: "error", exited: true, hasActions: true }),
  ).toBe("err");
});

test("lint: the sheet animates the icon of the three states that may move, and of no other", () => {
  const selectors = animatedIconSelectors(css);
  // Rule 22: a cycle over a filtered list checks the list is not empty. An empty
  // one would mean the sheet had stopped animating anything, and the two
  // "does not move" checks below would then pass for the wrong reason.
  expect(selectors.length).toBeGreaterThan(0);
  expect([...selectors].sort()).toEqual([...MAY_MOVE].sort());
});

test("lint: neither a suspended nor a closed session's icon is a selector the sheet animates", () => {
  const selectors = animatedIconSelectors(css);
  expect(selectors.length).toBeGreaterThan(0);
  for (const state of [SUSPENDED, CLOSED]) {
    const icon = `ic-${state}`;
    for (const selector of selectors) {
      expect([icon, selector, selector.includes(`.${icon}`)]).toEqual([
        icon,
        selector,
        false,
      ]);
    }
  }
});
