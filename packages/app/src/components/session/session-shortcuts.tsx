import { For, Show, createMemo } from "solid-js"
import { Keybind } from "@nikcli-ai/ui/keybind"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"

/**
 * What the empty session teaches.
 *
 * The blank state used to show the project path, the branch and a modified-at
 * timestamp — three facts the user cannot act on. Meanwhile every capability the
 * app has grown lives behind a keybind or the palette, and nothing on screen
 * says so, which is exactly how features end up built and unused.
 *
 * Bindings are read back from the command registry rather than written here, so
 * a rebound key shows its real value and a command that lost its binding drops
 * out instead of lying.
 */

/** Ordered by how early a new user needs them. */
const SHORTCUT_COMMANDS = [
  "session.new",
  "review.toggle",
  "fileTree.toggle",
  "terminal.new",
  "browser.visualEditor.open",
  "transcript.verbosity",
] as const

export function SessionShortcuts() {
  const command = useCommand()
  const language = useLanguage()

  const shortcuts = createMemo(() => {
    // Titles come from the registry too: a command that is not registered in this
    // context simply does not appear, rather than showing a dead row.
    const registered = new Map(command.options.map((option) => [option.id, option.title]))
    return SHORTCUT_COMMANDS.map((id) => ({
      id: id as string,
      title: registered.get(id) ?? "",
      keybind: command.keybind(id),
    })).filter((entry) => !!entry.keybind && !!entry.title)
  })

  return (
    <Show when={shortcuts().length > 0}>
      <div data-component="session-shortcuts">
        <For each={shortcuts()}>
          {(shortcut) => (
            <button
              type="button"
              data-slot="session-shortcut"
              onClick={() => command.trigger(shortcut.id, "palette")}
            >
              <span data-slot="session-shortcut-title">{shortcut.title}</span>
              <Keybind>{shortcut.keybind}</Keybind>
            </button>
          )}
        </For>
        <div data-slot="session-shortcut-hint">
          {language.t("session.new.shortcuts.more", { keybind: command.keybind("command.palette") })}
        </div>
      </div>
    </Show>
  )
}
