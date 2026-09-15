import type { Command } from "../command/registry"
import { DEFAULT_BINDINGS } from "../keyboard/bindings"
import { formatChord, parseChord, type Platform } from "../keyboard/keymap"
import type { RecentEntry } from "../host/recent"
import { ADE_VIEWS, ADE_VIEW_LABELS, nextView, type Workbench } from "./state"

export interface SurfaceCommand extends Command {
  /** Why the command cannot run now. Shown instead of hiding the row. */
  disabledReason?: string
  description?: string
}

/**
 * One command a loaded plugin has offered.
 *
 * Deliberately not `RegisteredCommand` from `../plugin/registry`: what the
 * palette needs is four strings, and the registry entry also carries the
 * handler. Keeping the handler out of here means nothing in this module can
 * run plugin code, which is the point — `buildCommands` only decides what is
 * *listed*, and the workbench decides what is invoked.
 */
export interface PluginCommandEntry {
  /** Already namespaced by the plugin host: `plugin:<id>:<command>`. */
  id: string
  title: string
  group: string
  keywords?: string[]
}

export interface CommandContext {
  workbench: Workbench
  recents: RecentEntry[]
  hasHost: boolean
  /** Ids of panes with a live process behind them. */
  running: ReadonlySet<string>
  platform: Platform
  voiceAvailable?: boolean
  voiceActive?: boolean
  voiceChord?: string
  /** Commands contributed by loaded plugins. Empty when none are loaded. */
  pluginCommands?: PluginCommandEntry[]
}

/**
 * The shortcut a command is actually bound to.
 *
 * Derived rather than written out beside each command: a palette that shows a
 * key combination the keymap does not implement teaches the user something
 * false, and that drift is invisible until someone presses the key.
 */
function shortcutFor(
  commandId: string,
  platform: Platform,
  voiceChord?: string
): string | undefined {
  if (commandId === "voice.toggle") {
    const chordStr = voiceChord ?? "mod+shift+k"
    return formatChord(parseChord(chordStr, platform), platform)
  }
  const entry = DEFAULT_BINDINGS.find((binding) => binding.commandId === commandId)
  return entry ? formatChord(parseChord(entry.chord, platform), platform) : undefined
}

/**
 * Whether running this command must leave the palette open.
 *
 * `runCommand` closes the palette on its last line, which is right for every
 * command that does something elsewhere — you picked it, it ran, the overlay
 * gets out of the way. It is exactly wrong for the one command whose whole
 * effect is to open the palette: opening and then closing in the same
 * synchronous pass meant Ctrl+Shift+P opened nothing at all, while the header
 * button kept working because it calls the setter directly. The rule lives
 * here, named and pinned by a test, rather than as a `return` inside a
 * component nothing can reach.
 */
export function keepsPaletteOpen(commandId: string): boolean {
  return commandId === "palette.open"
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
      id: "pane.rename",
      title: "Rinomina sessione",
      group: "Pannello",
      enabled: !!focusedPane,
      disabledReason: focusedPane ? undefined : "Nessun pannello a fuoco",
      shortcut: shortcutFor("pane.rename", platform),
    },
    {
      id: "view.toggle",
      title: `Sezione successiva (${ADE_VIEW_LABELS[nextView(workbench.view)]})`,
      group: "Vista",
      shortcut: shortcutFor("view.toggle", platform),
    },
    /*
     * One command per section, beside the cycle.
     *
     * With two views a toggle was the whole navigation; with four it is a way
     * of pressing a key three times to get somewhere. The palette is how ADE
     * is driven, so each section is reachable by name from it — and the one
     * already open is offered as disabled rather than hidden, so the list does
     * not change shape as you move around it.
     */
    ...ADE_VIEWS.map((view) => ({
      id: `view.${view}`,
      title: `Vai a ${ADE_VIEW_LABELS[view]}`,
      group: "Vista",
      enabled: workbench.view !== view,
      disabledReason: workbench.view === view ? "Sei già qui" : undefined,
    })),
    {
      id: "theme.toggle",
      title: "Cambia tema",
      group: "Vista",
      keywords: ["chiaro", "scuro"],
      shortcut: shortcutFor("theme.toggle", platform),
    },
    {
      id: "voice.toggle",
      title: ctx.voiceActive ? "Disattiva il controllo vocale" : "Attiva il controllo vocale",
      group: "Vista",
      keywords: ["voce", "microfono", "audio", "parla"],
      enabled: ctx.voiceAvailable !== false,
      disabledReason: ctx.voiceAvailable !== false ? undefined : "Riconoscimento vocale non supportato da questo browser",
      shortcut: shortcutFor("voice.toggle", platform, ctx.voiceChord),
    },
    {
      id: "voice.settings",
      title: "Impostazioni vocali",
      group: "Vista",
      keywords: ["voce", "impostazioni", "microfono", "audio", "configurazione"],
    },
    {
      id: "browser.new",
      title: "Apri browser",
      group: "Pannello",
      keywords: ["anteprima", "localhost"],
    },
    {
      id: "video.new",
      title: "Apri video",
      group: "Pannello",
      keywords: ["riproduttore", "player", "registrazione", "mp4", "fotogramma"],
    },
    {
      id: "model.new",
      title: "Apri modello 3D",
      group: "Pannello",
      keywords: ["3d", "gltf", "glb", "obj", "stl", "fbx", "mesh", "visualizzatore"],
    },
    {
      id: "app.new",
      title: "Apri simulatore app",
      group: "Pannello",
      keywords: ["simulatore", "emulatore", "telefono", "mobile", "expo", "tauri", "dispositivo", "finestra"],
    },
    {
      id: "decisions.open",
      title: "Decisioni per te",
      group: "Pannello",
      keywords: ["decisioni", "decidere", "scelte", "domande", "master", "bearings", "rispondi"],
    },
    {
      id: "decisions.pane",
      title: "Apri pannello Decisioni",
      group: "Pannello",
      keywords: ["decisioni", "registro", "risposte", "rimandate", "chiuse", "bearings"],
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

  /*
   * Plugin commands go last, and they go through a collision check on the way.
   *
   * Last because ADE's own commands are what the palette is for and a plugin
   * should not outrank them in an empty query. The check because this is the
   * final gate before the list reaches the palette: `trust.ts` already
   * namespaces every plugin command so a collision cannot be constructed, and
   * a collision arriving here anyway would mean that namespacing has broken —
   * in which case dropping the row is far better than letting a plugin answer
   * to `pane.close`.
   */
  const claimed = new Set(commands.map((command) => command.id))
  for (const plugin of ctx.pluginCommands ?? []) {
    if (claimed.has(plugin.id)) continue
    claimed.add(plugin.id)
    commands.push({
      id: plugin.id,
      title: plugin.title,
      group: plugin.group,
      keywords: plugin.keywords,
    })
  }

  return commands
}
