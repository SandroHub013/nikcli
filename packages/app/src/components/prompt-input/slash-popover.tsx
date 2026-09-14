import { Component, For, Match, Show, Switch } from "solid-js"
import { FileIcon } from "@nikcli-ai/ui/file-icon"
import { Icon } from "@nikcli-ai/ui/icon"
import { getDirectory, getFilename } from "@nikcli-ai/util/path"

/** How many rows the menu draws. */
const ROWS = 10

export type AtOption =
  | { type: "agent"; name: string; display: string }
  | { type: "file"; path: string; display: string; recent?: boolean }
  /**
   * Whatever is on a terminal right now.
   *
   * The one entry the agent cannot fetch for itself: it sees the output of the
   * commands *it* runs, not of the terminal the user is driving.
   */
  | { type: "terminal"; id: string; display: string }

export interface SlashCommand {
  id: string
  trigger: string
  title: string
  description?: string
  keybind?: string
  type: "builtin" | "custom"
  source?: "command" | "mcp" | "skill"
}

type PromptPopoverProps = {
  popover: "at" | "slash" | null
  setSlashPopoverRef: (el: HTMLDivElement) => void
  atFlat: AtOption[]
  atActive?: string
  atKey: (item: AtOption) => string
  setAtActive: (id: string) => void
  onAtSelect: (item: AtOption) => void
  slashFlat: SlashCommand[]
  slashActive?: string
  setSlashActive: (id: string) => void
  onSlashSelect: (item: SlashCommand) => void
  commandKeybind: (id: string) => string | undefined
  t: (key: string) => string
}

export const PromptPopover: Component<PromptPopoverProps> = (props) => {
  return (
    <Show when={props.popover}>
      <div
        ref={(el) => {
          if (props.popover === "slash") props.setSlashPopoverRef(el)
        }}
        class="absolute inset-x-0 -top-3 -translate-y-full origin-bottom-left max-h-80 min-h-10
                 overflow-auto no-scrollbar flex flex-col p-2 rounded-md
                 border border-border-base bg-surface-raised-stronger-non-alpha shadow-md"
        onMouseDown={(e) => e.preventDefault()}
      >
        <Switch>
          <Match when={props.popover === "at"}>
            <Show
              when={props.atFlat.length > 0}
              fallback={<div class="text-text-weak px-2 py-1">{props.t("prompt.popover.emptyResults")}</div>}
            >
              {/*
                Ten rows. Worth knowing when ordering the groups: with ten agents
                configured, an eleventh entry of any kind is produced, grouped and
                sorted correctly and then never drawn. Anything rarer than files
                belongs above them.
              */}
              <For each={props.atFlat.slice(0, ROWS)}>
                {(item) => (
                  <button
                    classList={{
                      "w-full flex items-center gap-x-2 rounded-md px-2 py-0.5": true,
                      "bg-surface-raised-base-hover": props.atActive === props.atKey(item),
                    }}
                    onClick={() => props.onAtSelect(item)}
                    onMouseEnter={() => props.setAtActive(props.atKey(item))}
                  >
                    {/*
                      A branch per option type. It used to be a two-way `Show`
                      where anything that was not an agent rendered as a file —
                      so a third type drew an icon with no path and no name: a row
                      that is present, selectable and completely blank.
                    */}
                    <Switch>
                      <Match when={item.type === "agent" && item}>
                        {(agent) => (
                          <>
                            <Icon name="brain" size="small" class="text-icon-info-active shrink-0" />
                            <span class="text-14-regular text-text-strong whitespace-nowrap">@{agent().name}</span>
                          </>
                        )}
                      </Match>
                      <Match when={item.type === "terminal" && item}>
                        {(entry) => (
                          <>
                            <Icon name="console" size="small" class="text-icon-base shrink-0" />
                            <span class="text-14-regular text-text-strong whitespace-nowrap truncate min-w-0">
                              {entry().display}
                            </span>
                          </>
                        )}
                      </Match>
                      <Match when={item.type === "file" && item}>
                        {(file) => (
                          <>
                            <FileIcon node={{ path: file().path, type: "file" }} class="shrink-0 size-4" />
                            <div class="flex items-center text-14-regular min-w-0">
                              <span class="text-text-base whitespace-nowrap truncate min-w-0">
                                {file().path.endsWith("/") ? file().path : getDirectory(file().path)}
                              </span>
                              <Show when={!file().path.endsWith("/")}>
                                <span class="text-text-strong whitespace-nowrap">{getFilename(file().path)}</span>
                              </Show>
                            </div>
                          </>
                        )}
                      </Match>
                    </Switch>
                  </button>
                )}
              </For>
            </Show>
          </Match>
          <Match when={props.popover === "slash"}>
            <Show
              when={props.slashFlat.length > 0}
              fallback={<div class="text-text-weak px-2 py-1">{props.t("prompt.popover.emptyCommands")}</div>}
            >
              <For each={props.slashFlat}>
                {(cmd) => (
                  <button
                    data-slash-id={cmd.id}
                    classList={{
                      "w-full flex items-center justify-between gap-4 rounded-md px-2 py-1": true,
                      "bg-surface-raised-base-hover": props.slashActive === cmd.id,
                    }}
                    onClick={() => props.onSlashSelect(cmd)}
                    onMouseEnter={() => props.setSlashActive(cmd.id)}
                  >
                    <div class="flex items-center gap-2 min-w-0">
                      <span class="text-14-regular text-text-strong whitespace-nowrap">/{cmd.trigger}</span>
                      <Show when={cmd.description}>
                        <span class="text-14-regular text-text-weak truncate">{cmd.description}</span>
                      </Show>
                    </div>
                    <div class="flex items-center gap-2 shrink-0">
                      <Show when={cmd.type === "custom" && cmd.source !== "command"}>
                        <span class="text-11-regular text-text-weak px-1.5 py-0.5 bg-surface-base rounded">
                          {cmd.source === "skill"
                            ? props.t("prompt.slash.badge.skill")
                            : cmd.source === "mcp"
                              ? props.t("prompt.slash.badge.mcp")
                              : props.t("prompt.slash.badge.custom")}
                        </span>
                      </Show>
                      <Show when={props.commandKeybind(cmd.id)}>
                        <span class="text-13-regular text-text-weak">{props.commandKeybind(cmd.id)}</span>
                      </Show>
                    </div>
                  </button>
                )}
              </For>
            </Show>
          </Match>
        </Switch>
      </div>
    </Show>
  )
}
