/**
 * What a take must never show (S36): the values that are secrets.
 *
 * Covered by the page itself for as long as a take runs, so the value is never
 * drawn and no frame can contain it. The rule lives in `index.css` under
 * `html[data-ade-recording]`, generated from the list below.
 *
 * The selector used to end in `#openrouter-key-field`: one id, cabled for one
 * field. That field is real — it is the OpenRouter key in
 * `packages/voice/src/ui/voice-settings-panel.tsx`, and pressing «Mostra»
 * really does turn it into `type="text"` with the key in the clear — so the
 * old rule was covering something. What it was not doing was covering
 * anything else: a name protects one field until someone renames it, and says
 * nothing about the field written next to it. The cost of forgetting here is a
 * key in a video.
 *
 * So the cover is chosen by shape, in four nets, and a value has to escape all
 * four to be filmed:
 *
 *   1. `[data-sensitive]` — the explicit mark, for a value this file cannot
 *      recognise: a rendered key, a log line, a QR code.
 *   2. `input[type="password"]`, and the autocomplete tokens the platform
 *      itself uses for credentials — a browser that autofills a password into
 *      a field has already decided that field holds one.
 *   3. The name a field gives itself, on any of the attributes a name is
 *      actually written on (`id`, `name`, `aria-label`, `placeholder`,
 *      `data-testid`), and the prefixes a real key is printed with. It can
 *      over-cover — a "keywords" box disappears from a take — and that is the
 *      right direction to be wrong in.
 *   4. `[data-secrets] *` — a whole zone. This is the net that fails safe: the
 *      mark is on the container, so a field added to the key form tomorrow is
 *      born covered, without anyone editing this file.
 *
 * Nets 2 and 3 used to be written for `<input>` only, which left out the shape
 * a long secret is actually pasted into: a PEM key, a service-account JSON or
 * an SSH key goes in a `<textarea>` or a `contenteditable`. They now match any
 * field, not any input.
 *
 * The fourth net is still the one to reach for. Nets 2 and 3 recognise a value
 * by how it looks, and a value can always be made to look like something else
 * — `pat`, `bearer`, `dsn` and `credential` are the names people write first,
 * and the list of them can only ever be the ones we thought of. The zone does
 * not need to recognise anything, which is why it is the one that survives
 * being forgotten. When in doubt, mark the container.
 *
 * Two things this cover cannot reach, and they are not oversights: the
 * terminal, whose lines match no net, and the browser pane, which is an
 * `<iframe>` holding somebody else's document that our CSS never enters.
 * Both need a cover over the whole pane rather than over a field. The
 * terminal has one now (D68): every row blurred unless judged clean, with
 * the same words and prefixes as here — see `terminal/recording-cover.ts`.
 */
import { createSignal } from "solid-js"
import { coverTerminals } from "../terminal/registry"

/** The zones that hold credentials. Everything inside is covered. */
export const SECRET_ZONE_ATTRIBUTE = "data-secrets"

/** Anything a value can be typed into — not just `<input>`. */
const FIELD = ":is(input, textarea, select, [contenteditable])"

/** The attributes a field uses to say what it is; a Solid input often has no id. */
const NAMED_BY = ["id", "name", "aria-label", "placeholder", "data-testid"]

/** Words that mean «this holds a credential», in both languages of this app. */
export const SECRET_WORDS = [
  "key",
  "chiave",
  "token",
  "secret",
  "segreto",
  "credential",
  "credenziale",
  "passphrase",
  "password",
  "bearer",
  "authorization",
  "dsn",
  "otp",
]

/** Words too short to look for inside another word: `pat` is also `path`. */
export const SECRET_EXACT_WORDS = ["pat"]

/** How a real key announces itself when the box asks you to paste one. */
export const SECRET_PREFIXES = ["sk-", "ghp_", "gho_", "ghs_", "github_pat_", "xox", "AKIA", "AIza", "glpat-", "hf_", "eyJ"]

const anyField = (conditions: string[]): string => `${FIELD}:is(${conditions.join(", ")})`

const onAnyName = (test: (attribute: string) => string): string[] => NAMED_BY.map(test)

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
  anyField(SECRET_WORDS.flatMap((word) => onAnyName((attribute) => `[${attribute}*="${word}" i]`))),
  anyField(SECRET_EXACT_WORDS.flatMap((word) => onAnyName((attribute) => `[${attribute}="${word}" i]`))),
  anyField(SECRET_PREFIXES.map((prefix) => `[placeholder^="${prefix}" i]`)),
  `[${SECRET_ZONE_ATTRIBUTE}]`,
  `[${SECRET_ZONE_ATTRIBUTE}] *`,
]

export const SENSITIVE_SELECTOR = SENSITIVE_PARTS.join(", ")

export const RECORDING_ATTRIBUTE = "data-ade-recording"

const [covering, setCovering] = createSignal(false)

/** Whether a take is covering secrets now: for the covers that need to judge, like a file pane's. */
export const coveringSecrets = covering

/**
 * Covers or uncovers the secret fields and the terminals; the user sees them
 * covered too while filming.
 */
export function coverSecrets(on: boolean, root: HTMLElement = document.documentElement): void {
  if (on) root.setAttribute(RECORDING_ATTRIBUTE, "")
  else root.removeAttribute(RECORDING_ATTRIBUTE)
  coverTerminals(on)
  setCovering(on)
}
