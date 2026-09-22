/**
 * What a take must never show (S36): the fields that hold a secret.
 *
 * Covered by the page itself for as long as a take runs, so the value is never
 * drawn and no frame can contain it. The rule lives in `index.css` under
 * `html[data-ade-recording]`.
 *
 * The selector used to end in `#openrouter-key-field`: one id, cabled for one
 * field. Any key field added afterwards was on its own — and by the time this
 * was looked at, that id no longer existed anywhere in the app, so the third
 * of the three rules was covering nothing at all. A name that protects one
 * field protects it until someone renames it, and the cost of forgetting here
 * is a key in a video, not an ugly panel.
 *
 * So the cover is chosen by shape, in four nets, and a field has to escape
 * all four to be filmed:
 *
 *   1. `[data-sensitive]` — the explicit mark, for anything this file cannot
 *      recognise (a rendered value, a log line, a QR code).
 *   2. `input[type="password"]`, and the autocomplete tokens the platform
 *      itself uses for credentials — a browser that autofills a password into
 *      a field has already decided that field holds one.
 *   3. The names a field gives itself: an `id` or `name` containing key,
 *      token or secret, or a placeholder starting `sk-`. This is what keeps
 *      the OpenRouter field covered when «Mostra» turns it into
 *      `type="text"` — measured live: press it and the type really does
 *      change, which is why an id had been cabled in here in the first place.
 *      It can over-cover (a "keywords" field would be hidden in a take), and
 *      that is the right direction to be wrong in.
 *   4. `[data-secrets] *` — a whole zone. This is the net that fails safe:
 *      the mark is on the container, so a field added to the key form
 *      tomorrow is born covered, without anyone editing this file or
 *      remembering an attribute on the input itself.
 *
 * The fourth is why the zone is marked rather than the fields: forgetting is
 * the normal case, and the only cover that survives forgetting is one that is
 * already there before the field is written.
 */

/** The zones that hold credentials. Everything inside is covered. */
export const SECRET_ZONE_ATTRIBUTE = "data-secrets"

/**
 * The pieces of the selector, kept apart so the stylesheet and the tests can
 * walk the same list instead of each keeping its own copy.
 */
export const SENSITIVE_PARTS = [
  "[data-sensitive]",
  'input[type="password"]',
  'input[autocomplete="current-password"]',
  'input[autocomplete="new-password"]',
  'input[autocomplete="one-time-code"]',
  // A field that calls itself a key, a token or a secret is one.
  'input[id*="key" i]',
  'input[name*="key" i]',
  'input[id*="token" i]',
  'input[name*="token" i]',
  'input[id*="secret" i]',
  'input[name*="secret" i]',
  'input[placeholder^="sk-" i]',
  `[${SECRET_ZONE_ATTRIBUTE}]`,
  `[${SECRET_ZONE_ATTRIBUTE}] *`,
] as const

export const SENSITIVE_SELECTOR = SENSITIVE_PARTS.join(", ")

export const RECORDING_ATTRIBUTE = "data-ade-recording"

/** Covers or uncovers the secret fields; the user sees them covered too while filming. */
export function coverSecrets(on: boolean, root: HTMLElement = document.documentElement): void {
  if (on) root.setAttribute(RECORDING_ATTRIBUTE, "")
  else root.removeAttribute(RECORDING_ATTRIBUTE)
}
