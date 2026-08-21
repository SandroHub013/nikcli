import type { Command } from "../command/registry"
import { DEFAULT_BINDINGS } from "../keyboard/bindings"
import { formatChord, parseChord, type Platform } from "../keyboard/keymap"
import type { RecentEntry } from "../host/recent"
import type { Workbench } from "./state"

export interface SurfaceCommand extends Command {
  /** Why the command cannot run now. Shown instead of hiding the row. */
  disabledReason?: string
  description?: string
}

export interface CommandContext {
  workbench: Workbench
  recents: RecentEntry[]
  hasHost: boolean
  /** Ids of panes with a live process behind them. */
  running: ReadonlySet<string>
  platform: Platform
}

/**
 * The shortcut a command is actually bound to.
 *
 * Derived rather than written out beside each command: a palette that shows a
 * key combination the keymap does not implement teaches the user something
 * false, and that drift is invisible until someone presses the key.
 */
function shortcutFor(commandId: string, platform: Platform): string | undefined {
  const entry = DEFAULT_BINDINGS.find((binding) => binding.commandId === commandId)
  return entry ? formatChord(parseChord(entry.chord, platform), platform) : undefined
}

/**
 * Every command the palette can offer, given what is true right now.
 *
 * A command that cannot run stays in the list with the reason attached. Removing
 * it would be worse: the user who looked for it concludes they misremembered the
 * name, and goes looking again.
 */
export function buildCommands(ctx: CommandContext): SurfaceCommand[] {
  const { workbench, recents, hasHost, running, platform } = ctx
  const focusedPane = workbench.focusedId
    ? workbench.panes.find((pane) => pane.id === workbench.focusedId)
    : undefined
  const focusedRuns = !!focusedPane && running.has(focusedPane.id)
  const desktopOnly = hasHost ? undefined : "Richiede l'app desktop"

  const commands: SurfaceCommand[] = [
    {
      id: "session.new",
      title: "Nuova sessione",
      group: "Sessione",
      keywords: ["avvia", "agente", "lancia"],
      shortcut: shortcutFor("session.new", platform),
    },
    {
      id: "project.open",
      title: "Apri progetto",
      group: "Progetto",
      keywords: ["cartella", "repository"],
      enabled: hasHost,
      disabledReason: desktopOnly,
    },
    {
      id: "pane.close",
      title: "Chiudi pannello",
      group: "Pannello",
      enabled: !!focusedPane,
      disabledReason: focusedPane ? undefined : "Nessun pannello a fuoco",
      shortcut: shortcutFor("pane.close", platform),
    },
    {
      id: "pane.expand",
      title: workbench.expandedId ? "Riduci pannello" : "Espandi pannello",
      group: "Pannello",
      enabled: !!focusedPane,
      disabledReason: focusedPane ? undefined : "Nessun pannello a fuoco",
      shortcut: shortcutFor("pane.expand", platform),
    },
    {
      id: "view.toggle",
      title: workbench.view === "plancia" ? "Passa agli alberi" : "Passa alla plancia",
      group: "Vista",
      shortcut: shortcutFor("view.toggle", platform),
    },
    {
      id: "theme.toggle",
      title: "Cambia tema",
      group: "Vista",
      keywords: ["chiaro", "scuro"],
      shortcut: shortcutFor("theme.toggle", platform),
    },
    {
      id: "browser.new",
      title: "Apri browser",
      group: "Pannello",
      keywords: ["anteprima", "localhost"],
    },
    {
      id: "worktrees.reload",
      title: "Ricarica alberi",
      group: "Alberi",
      enabled: hasHost,
      disabledReason: desktopOnly,
    },
    {
      id: "process.kill",
      title: "Uccidi processo",
      group: "Processo",
      keywords: ["ferma", "termina"],
      enabled: focusedRuns,
      disabledReason: focusedRuns ? undefined : "Il pannello a fuoco non ha un processo vivo",
    },
  ]

  for (const recent of recents) {
    commands.push({
      id: `project.recent.${recent.root}`,
      title: recent.name,
      group: "Progetti recenti",
      enabled: hasHost,
      disabledReason: desktopOnly,
      description: recent.root,
    })
  }

  return commands
}
