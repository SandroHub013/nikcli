import { t } from "../i18n"
import type { LaunchEntry } from "../session-new/launch"
import { sameProject } from "./pane-project"

/**
 * What a new pane is called when its task does not name it, as
 * "Sessione 3 — Claude Code" or "Session 3 — Claude Code".
 *
 * In the interface language of the moment the pane is created: the title is
 * then stored with the pane, so a session opened in Italian keeps its name
 * when the language changes, and a rename is never undone.
 *
 * `index` is the slot in the launch that makes the pane, so every launch of one session started again at 1 and two
 * Terminals were both «Sessione 1 — Terminale» (live test 3, FAIL 10). `taken` are the titles the panes of the same
 * project already wear (`titlesOfProject`): the number goes up to the first one that none of them has. Required, so a
 * caller that forgets it does not type-check.
 */
export function defaultPaneTitle(
  role: LaunchEntry["role"],
  index: number,
  agent: string,
  taken: readonly string[],
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

/**
 * The titles the panes of one project wear: the numbers are counted per project, so the first Terminal of a project is
 * «Sessione 1» whatever the others hold. `owner` is the new pane's own project (its folder, and its name for panes saved
 * before the folder was kept), as `sameProject` reads it.
 */
export function titlesOfProject(
  panes: readonly { readonly title: string; readonly workspaceId?: string; readonly projectRoot?: string }[],
  owner: { readonly workspaceId?: string; readonly projectRoot?: string },
): string[] {
  return panes.filter((pane) => sameProject(pane, owner)).map((pane) => pane.title)
}
