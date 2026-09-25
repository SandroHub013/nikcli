/**
 * The folder's sessions, beside the conversation (C4): open one, or rename it
 * with a double click on its title or F2, as a pane is. What it shows is
 * decided in `sessions.ts`; the titles are the server's, and go into text
 * nodes only.
 */

import { createSignal, For, Show } from "solid-js"
import { t } from "../i18n"
import type { SessionEntry } from "./sessions"

export function SessionList(props: {
  entries: readonly SessionEntry[]
  current: string | undefined
  onOpen: (sessionID: string) => void
  onRename: (sessionID: string, title: string) => Promise<void>
}) {
  const [renaming, setRenaming] = createSignal<string>()
  const [failed, setFailed] = createSignal<string>()

  const begin = (sessionID: string) => {
    setFailed(undefined)
    setRenaming(sessionID)
  }

  const commit = async (sessionID: string, title: string) => {
    setFailed(undefined)
    try {
      await props.onRename(sessionID, title)
      setRenaming(undefined)
    } catch (error) {
      setFailed(error instanceof Error ? error.message : t("chat.answer.failed"))
    }
  }

  return (
    <nav data-slot="chat-sessions" aria-label={t("chat.sessions.label")}>
      <Show
        when={props.entries.length > 0}
        fallback={<p data-slot="chat-sessions-empty">{t("chat.sessions.empty")}</p>}
      >
        <ul data-slot="chat-session-list">
          <For each={props.entries}>
            {(entry) => (
              <li data-slot="chat-session" data-current={entry.id === props.current} data-chat={entry.chat}>
                <Show
                  when={renaming() === entry.id}
                  fallback={
                    <button
                      type="button"
                      data-slot="chat-session-open"
                      aria-current={entry.id === props.current ? "true" : undefined}
                      title={t("chat.session.renameHint")}
                      onClick={() => props.onOpen(entry.id)}
                      onDblClick={() => begin(entry.id)}
                      onKeyDown={(event) => {
                        if (event.key === "F2") {
                          event.preventDefault()
                          begin(entry.id)
                        }
                      }}
                    >
                      <span data-slot="chat-session-title">{entry.title}</span>
                      <Show when={entry.waiting}>
                        <span data-slot="chat-session-mark" data-kind="waiting">
                          {t("chat.session.waiting")}
                        </span>
                      </Show>
                      <Show when={!entry.waiting && entry.busy}>
                        <span data-slot="chat-session-mark">{t("chat.session.busy")}</span>
                      </Show>
                      <Show when={!entry.chat}>
                        <span data-slot="chat-session-mark">{t("chat.session.foreign")}</span>
                      </Show>
                    </button>
                  }
                >
                  <input
                    type="text"
                    data-slot="chat-session-input"
                    aria-label={t("chat.session.renameInput")}
                    value={entry.title}
                    ref={(el) =>
                      queueMicrotask(() => {
                        el.focus()
                        el.select()
                      })
                    }
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault()
                        void commit(entry.id, event.currentTarget.value)
                      } else if (event.key === "Escape") {
                        event.preventDefault()
                        setRenaming(undefined)
                      }
                    }}
                    onBlur={() => setRenaming(undefined)}
                  />
                </Show>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <Show when={failed()}>{(message) => <p data-slot="chat-error">{message()}</p>}</Show>
    </nav>
  )
}
