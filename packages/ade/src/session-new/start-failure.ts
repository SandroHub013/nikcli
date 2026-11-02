/**
 * What a session that did not start tells the user (UX-9, UX-24).
 *
 * The host refuses with a reason in Italian, written in Rust
 * (`pty.rs`): «programma non trovato: claude», «pty non creata: …». Shown as
 * it came, it reached the English UI in Italian and said what failed but not
 * what to do. Here each known reason becomes a sentence in the language of the
 * UI, and the program that is not installed gets the one thing that fixes it.
 * A reason that is not known is kept, minus the «Error: » of a thrown error.
 */
import { t } from "../i18n"

type ReasonKey =
  | "pane.reason.cantRun"
  | "pane.reason.noPty"
  | "pane.reason.optionRefused"
  | "pane.reason.commandRefused"
  | "pane.reason.needsTerminal"
  | "pane.reason.keyMissing"
  | "pane.reason.keyAnthropic"
  | "pane.reason.keyOpenAi"
  | "pane.reason.subscriptionNoKey"
  | "pane.reason.sshArgument"
  | "pane.reason.sshPort"
  | "pane.reason.sshValue"
  | "pane.reason.sshNoDestination"
  | "pane.reason.shellArgument"
  | "pane.reason.unsafeArgument"

/** Rust's wording, in the order it is tried, and the catalog text each one becomes. */
const KNOWN: readonly { readonly match: RegExp; readonly key: ReasonKey }[] = [
  { match: /^(.+) non parte: (.+)$/s, key: "pane.reason.cantRun" },
  { match: /^pty non creata: (.+)$/s, key: "pane.reason.noPty" },
  { match: /^opzione di avvio non consentita per (.+): (.+)$/s, key: "pane.reason.optionRefused" },
  { match: /^comando non consentito: (.+)$/s, key: "pane.reason.commandRefused" },
  { match: /^(.+) non si avvia senza terminale$/s, key: "pane.reason.needsTerminal" },
  { match: /^modalità chiave senza una chiave$/, key: "pane.reason.keyMissing" },
  { match: /^modalità chiave: attesa la variabile ANTHROPIC_API_KEY$/, key: "pane.reason.keyAnthropic" },
  { match: /^modalità chiave: attesa la variabile CODEX_API_KEY o OPENAI_API_KEY$/, key: "pane.reason.keyOpenAi" },
  { match: /^un abbonamento non riceve chiavi$/, key: "pane.reason.subscriptionNoKey" },
  { match: /^argomento ssh non consentito: (.+)$/s, key: "pane.reason.sshArgument" },
  { match: /^porta ssh non valida: (.+)$/s, key: "pane.reason.sshPort" },
  { match: /^valore ssh non valido: (.+)$/s, key: "pane.reason.sshValue" },
  { match: /^ssh senza destinazione$/, key: "pane.reason.sshNoDestination" },
  { match: /^argomento della shell non consentito: (.+)$/s, key: "pane.reason.shellArgument" },
  { match: /^argomento non sicuro per (.+): contiene (.+), che cmd\.exe interpreta$/s, key: "pane.reason.unsafeArgument" },
]

/** A thrown error's text without its «Error: » prefix. */
function plain(raw: string): string {
  return raw.replace(/^(?:\w*Error:\s*)+/, "").trim()
}

/** What to show of anything that was thrown: its message, never «Error: …» (UX-9). */
export function errorMessage(error: unknown): string {
  return plain(error instanceof Error ? error.message : String(error))
}

/** The reason as a phrase in the UI's language, with no «Error: » in front and no full stop at the end. */
export function reasonText(raw: string): string {
  const reason = plain(raw).replace(/\.+$/, "")
  for (const { match, key } of KNOWN) {
    const found = match.exec(reason)
    if (!found) continue
    const [, a = "", b = ""] = found
    return (t as (key: string, ...args: string[]) => string)(key, a, b)
  }
  return reason
}

/** The pane's note when a local session did not start. */
export function startFailureText(raw: string, agent?: { readonly label: string }): string {
  const missing = /^programma non trovato: (.+?)\.?$/s.exec(plain(raw))
  if (missing) return t("pane.startFailed.notFound", agent?.label ?? missing[1]!, missing[1]!)
  return t("pane.startFailed", reasonText(raw))
}

/** The pane's note when a connection did not open. */
export function connectFailureText(raw: string): string {
  return t("pane.connectFailed", reasonText(raw))
}
