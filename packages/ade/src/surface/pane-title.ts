import { t } from "../i18n"
import type { LaunchEntry } from "../session-new/launch"

/**
 * What a new pane is called when its task does not name it, as
 * "Sessione 3 — Claude Code" or "Session 3 — Claude Code".
 *
 * In the interface language of the moment the pane is created: the title is
 * then stored with the pane, so a session opened in Italian keeps its name
 * when the language changes, and a rename is never undone.
 *
 * `index` is the slot in the launch that makes the pane, so every launch of one session started again at 1 and two
 * Terminals were both «Sessione 1 — Terminale» (live test 3, FAIL 10). `taken` are the titles the panes already wear: the
 * number goes up to the first one that none of them has.
 */
export function defaultPaneTitle(
  role: LaunchEntry["role"],
  index: number,
  agent: string,
  taken: readonly string[] = [],
): string {
  const label =
    role === "reviewer" ? t("paneTitle.reviewer") : role === "shell" ? t("paneTitle.shell") : t("paneTitle.agent")
  // A terminal is named «Terminale 3», not «Terminale 3 — Terminale».
  const name = (n: number) => (agent === label ? `${label} ${n}` : `${label} ${n} — ${agent}`)
  const used = new Set(taken)
  let n = index
  while (used.has(name(n))) n++
  return name(n)
}
