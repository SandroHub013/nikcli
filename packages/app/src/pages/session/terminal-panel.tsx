import { createMemo, For, Show } from "solid-js"
import { Tabs } from "@nikcli-ai/ui/tabs"
import { ResizeHandle } from "@nikcli-ai/ui/resize-handle"
import { IconButton } from "@nikcli-ai/ui/icon-button"
import { showToast } from "@nikcli-ai/ui/toast"
import { formatTerminalExcerpt, terminalExcerpt } from "@/pages/session/terminal-context"
import { TooltipKeybind } from "@nikcli-ai/ui/tooltip"
import { DragDropProvider, DragDropSensors, DragOverlay, SortableProvider, closestCenter } from "@thisbeyond/solid-dnd"
import type { DragEvent } from "@thisbeyond/solid-dnd"
import { ConstrainDragYAxis } from "@/utils/solid-dnd"
import { SortableTerminalTab } from "@/components/session"
import { Terminal } from "@/components/terminal"
import { useTerminal, type LocalPTY } from "@/context/terminal"
import { useLanguage } from "@/context/language"
import { useCommand } from "@/context/command"
import { terminalTabLabel } from "@/pages/session/terminal-label"

export function TerminalPanel(props: {
  open: boolean
  height: number
  resize: (value: number) => void
  close: () => void
  terminal: ReturnType<typeof useTerminal>
  language: ReturnType<typeof useLanguage>
  command: ReturnType<typeof useCommand>
  handoff: () => string[]
  activeTerminalDraggable: () => string | undefined
  handleTerminalDragStart: (event: unknown) => void
  handleTerminalDragOver: (event: DragEvent) => void
  handleTerminalDragEnd: () => void
  onCloseTab: () => void
  /** Hands the terminal's output to the composer. */
  onSendToPrompt: (text: string) => void
}) {
  // Registered into the terminal context, so the composer's `@` menu can read
  // the same terminals this panel is showing.
  const readers = props.terminal.readers

  const sendToChat = () => {
    const active = props.terminal.active()
    const reader = readers.get(active)
    // No reader means the terminal has not finished loading. Reachable from the
    // palette, and returning quietly left the user with no idea why nothing
    // happened — so it says the same thing an empty terminal says.
    const excerpt = reader
      ? terminalExcerpt({ selection: reader.selection(), scrollback: reader.text() })
      : undefined
    if (!excerpt) {
      showToast({ variant: "error", title: props.language.t("terminal.sendToChat.empty") })
      return
    }
    // The tab's own name, not the generic word: with several terminals open it
    // is the only thing that says which one this came from. It is not a working
    // directory, and passing it as one read as "Terminal · Terminal 1".
    const name = props.terminal.all().find((t: LocalPTY) => t.id === active)?.title
    props.onSendToPrompt(
      formatTerminalExcerpt({ excerpt, title: name || props.language.t("terminal.title") }),
    )
    showToast({
      variant: "success",
      icon: "circle-check",
      title: props.language.t("terminal.sendToChat.done"),
    })
  }

  // Registered, not just wired to the button: the tooltip asks the keymap for a
  // shortcut, and an action that only exists as a button has none to give — nor
  // a place in the command palette or the shortcut sheet.
  props.command.register("terminal-send-to-chat", () => [
    {
      id: "terminal.sendToChat",
      title: props.language.t("terminal.sendToChat"),
      description: props.language.t("terminal.sendToChat.description"),
      category: props.language.t("command.category.session"),
      keybind: "mod+shift+u",
      disabled: !props.open,
      onSelect: sendToChat,
    },
  ])
  return (
    <Show when={props.open}>
      <div
        id="terminal-panel"
        role="region"
        aria-label={props.language.t("terminal.title")}
        class="relative w-full flex flex-col shrink-0 border-t border-border-weak-base"
        style={{ height: `${props.height}px` }}
      >
        <ResizeHandle
          direction="vertical"
          size={props.height}
          min={100}
          max={window.innerHeight * 0.6}
          collapseThreshold={50}
          onResize={props.resize}
          onCollapse={props.close}
        />
        <Show
          when={props.terminal.ready()}
          fallback={
            <div class="flex flex-col h-full pointer-events-none">
              <div class="h-10 flex items-center gap-2 px-2 border-b border-border-weak-base bg-background-stronger overflow-hidden">
                <For each={props.handoff()}>
                  {(title) => (
                    <div class="px-2 py-1 rounded-md bg-surface-base text-14-regular text-text-weak truncate max-w-40">
                      {title}
                    </div>
                  )}
                </For>
                <div class="flex-1" />
                <div class="text-text-weak pr-2">
                  {props.language.t("common.loading")}
                  {props.language.t("common.loading.ellipsis")}
                </div>
              </div>
              <div class="flex-1 flex items-center justify-center text-text-weak">
                {props.language.t("terminal.loading")}
              </div>
            </div>
          }
        >
          <DragDropProvider
            onDragStart={props.handleTerminalDragStart}
            onDragEnd={props.handleTerminalDragEnd}
            onDragOver={props.handleTerminalDragOver}
            collisionDetector={closestCenter}
          >
            <DragDropSensors />
            <ConstrainDragYAxis />
            <div class="flex flex-col h-full">
              <Tabs
                variant="alt"
                value={props.terminal.active()}
                onChange={(id) => props.terminal.open(id)}
                class="!h-auto !flex-none"
              >
                <Tabs.List class="h-10">
                  <SortableProvider ids={props.terminal.all().map((t: LocalPTY) => t.id)}>
                    <For each={props.terminal.all()}>
                      {(pty) => (
                        <SortableTerminalTab
                          terminal={pty}
                          onClose={() => {
                            props.close()
                            props.onCloseTab()
                          }}
                        />
                      )}
                    </For>
                  </SortableProvider>
                  <div class="h-full flex items-center justify-center">
                    <TooltipKeybind
                      title={props.language.t("terminal.sendToChat")}
                      keybind={props.command.keybind("terminal.sendToChat")}
                      class="flex items-center"
                    >
                      <IconButton
                        icon="arrow-up"
                        variant="ghost"
                        iconSize="large"
                        onClick={sendToChat}
                        aria-label={props.language.t("terminal.sendToChat")}
                      />
                    </TooltipKeybind>
                    <TooltipKeybind
                      title={props.language.t("command.terminal.new")}
                      keybind={props.command.keybind("terminal.new")}
                      class="flex items-center"
                    >
                      <IconButton
                        icon="plus-small"
                        variant="ghost"
                        iconSize="large"
                        onClick={props.terminal.new}
                        aria-label={props.language.t("command.terminal.new")}
                      />
                    </TooltipKeybind>
                  </div>
                </Tabs.List>
              </Tabs>
              <div class="flex-1 min-h-0 relative">
                <For each={props.terminal.all()}>
                  {(pty) => (
                    <div
                      id={`terminal-wrapper-${pty.id}`}
                      class="absolute inset-0"
                      style={{
                        display: props.terminal.active() === pty.id ? "block" : "none",
                      }}
                    >
                      {/*
                        The id is taken from the keyed value, not read off `pty`.
                        A reconnect calls `clone`, which rewrites the row in place,
                        so `pty.id` has already flipped to the new id by the time
                        the old branch tears down — it would delete a key that was
                        never set and leave the disposed terminal's closure, and
                        its whole scrollback, pinned for the life of the page.
                      */}
                      <Show when={pty.id} keyed>
                        {(id) => (
                        <Terminal
                          pty={pty}
                          onReader={(reader) => {
                            readers.set(id, reader)
                          }}
                          onCleanup={props.terminal.update}
                          onConnectError={() => props.terminal.clone(id)}
                        />
                        )}
                      </Show>
                    </div>
                  )}
                </For>
              </div>
            </div>
            <DragOverlay>
              <Show when={props.activeTerminalDraggable()}>
                {(draggedId) => {
                  const pty = createMemo(() => props.terminal.all().find((t: LocalPTY) => t.id === draggedId()))
                  return (
                    <Show when={pty()}>
                      {(t) => (
                        <div class="relative p-1 h-10 flex items-center bg-background-stronger text-14-regular">
                          {terminalTabLabel({
                            title: t().title,
                            titleNumber: t().titleNumber,
                            t: props.language.t as (
                              key: string,
                              vars?: Record<string, string | number | boolean>,
                            ) => string,
                          })}
                        </div>
                      )}
                    </Show>
                  )
                }}
              </Show>
            </DragOverlay>
          </DragDropProvider>
        </Show>
      </div>
    </Show>
  )
}
