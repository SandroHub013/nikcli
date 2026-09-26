/**
 * The rooms (B8b): their list under the bots, a room's conversation, the
 * form that makes one.
 *
 * The rules are in `room.ts` and the runs in `room-app.ts`: this draws the
 * rooms and hands the user's choices back. The question a member's turn is
 * waiting on is shown here, in the room, with the panel's buttons (B8c).
 */

import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js"
import { t } from "../i18n"
import { APPROVAL_TIMEOUT_MS } from "./approval"
import type { AgentFile } from "./nikcli"
import { MAX_MEMBERS, MIN_MEMBERS, ROOM_ROUND_MAX_USD, type RoomSpend } from "./room"
import { memberName, type RoomBook } from "./room-app"
import type { PendingPermission, PermissionAnswer } from "./talk"

export interface RoomDraft {
  readonly name: string
  readonly members: readonly string[]
  readonly spend?: RoomSpend
}

export interface RoomPanelDeps {
  readonly book: () => RoomBook
  /** The bots a room can be made of: the roster. */
  readonly bots: () => readonly AgentFile[]
  /** The member speaking in a room now, by its file. */
  readonly speaking: (roomId: string) => string | undefined
  /** The question a member's turn in a room is waiting on. */
  readonly permission: (roomId: string, path: string) => PendingPermission | undefined
  readonly answer: (path: string, choice: PermissionAnswer) => void
  /** Whether the message went: one that did not comes back into the composer. */
  readonly send: (roomId: string, text: string) => Promise<boolean>
  readonly stop: (roomId: string) => void
  /** The new room's id, or why it cannot be made. */
  readonly create: (draft: RoomDraft) => Promise<{ readonly id: string } | { readonly problem: string }>
  /** Whether it went: the user is asked first, the conversation goes with the room. */
  readonly remove: (roomId: string) => Promise<boolean>
}

/** The rooms, under the bots in the sidebar. */
export function RoomsRoster(props: {
  deps: RoomPanelDeps
  openId: string | undefined
  onOpen: (id: string) => void
  onNew: () => void
}) {
  return (
    <div data-slot="rooms-roster">
      <header data-slot="bots-roster-head">
        <span data-slot="bots-roster-title">{t("bots.room.section")}</span>
        <button type="button" data-slot="bots-new" onClick={() => props.onNew()} aria-label={t("bots.room.new")} title={t("bots.room.new")}>
          +
        </button>
      </header>
      <div data-slot="bots-list">
        <For each={props.deps.book().rooms}>
          {(room) => (
            <button
              type="button"
              data-slot="bots-row"
              data-active={room.id === props.openId ? "true" : undefined}
              data-status={props.deps.speaking(room.id) ? "working" : undefined}
              onClick={() => props.onOpen(room.id)}
            >
              <span data-slot="room-glyph" aria-hidden="true">#</span>
              <span data-slot="bots-row-text">
                <span data-slot="bots-row-name">{room.name}</span>
                <span data-slot="bots-row-line">
                  {room.members.map((path) => `@${memberName(props.deps.bots(), path)}`).join(" ")}
                </span>
              </span>
              <Show when={room.needsYou}>
                <span data-slot="room-needs-you" title={t("bots.room.needsYouTitle")}>
                  {t("bots.room.needsYou")}
                </span>
              </Show>
            </button>
          )}
        </For>
      </div>
    </div>
  )
}

/** A room's conversation, drawn in the main area. */
export function RoomMain(props: { deps: RoomPanelDeps; roomId: string; onRemoved: () => void }) {
  const room = createMemo(() => props.deps.book().rooms.find((entry) => entry.id === props.roomId))
  const [draft, setDraft] = createSignal("")
  let scroller: HTMLDivElement | undefined
  let field: HTMLTextAreaElement | undefined

  const speaking = () => props.deps.speaking(props.roomId)
  const asked = () => {
    const path = speaking()
    return path ? props.deps.permission(props.roomId, path) : undefined
  }
  const nameOf = (path: string) => memberName(props.deps.bots(), path)

  createEffect(
    on(
      () => [room()?.log.entries.length, speaking(), asked()],
      () => {
        if (scroller) scroller.scrollTop = scroller.scrollHeight
      },
    ),
  )
  createEffect(on(() => props.roomId, () => {
    setDraft("")
    field?.focus()
  }))

  const submit = async () => {
    const text = draft()
    if (text.trim().length === 0) return
    setDraft("")
    if (!(await props.deps.send(props.roomId, text)) && draft().length === 0) setDraft(text)
  }

  return (
    <Show when={room()}>
      {(current) => (
        <div data-slot="bots-thread" data-room="true">
          <header data-slot="room-head">
            <span data-slot="room-name"># {current().name}</span>
            <span data-slot="room-members">{current().members.map((path) => `@${nameOf(path)}`).join(" ")}</span>
            <Show when={current().spend}>
              {(spend) => <span data-slot="room-cap">{t("bots.room.capLine", `${spend().perRoundUsd.toFixed(2)} $`)}</span>}
            </Show>
            <button
              type="button"
              data-slot="bots-link"
              onClick={() => {
                void props.deps.remove(current().id).then((gone) => {
                  if (gone) props.onRemoved()
                })
              }}
            >
              {t("bots.room.delete")}
            </button>
          </header>

          <div data-slot="bots-messages" ref={(el) => (scroller = el)}>
            <Show when={current().log.entries.length === 0}>
              <p data-slot="bots-thread-empty-text">{t("bots.room.empty")}</p>
            </Show>
            <For each={current().log.entries}>
              {(entry) => (
                <div data-slot="bots-msg" data-role={entry.from.kind === "user" ? "user" : "assistant"}>
                  <div data-slot="bots-msg-body">
                    <Show when={entry.from.kind === "bot" ? entry.from : undefined}>
                      {(from) => <span data-slot="room-speaker">@{from().name}</span>}
                    </Show>
                    <p data-slot="bots-msg-text">{entry.text}</p>
                  </div>
                </div>
              )}
            </For>

            <Show when={current().needsYou}>
              <p data-slot="room-needs-you-line">
                <span data-slot="room-needs-you">{t("bots.room.needsYou")}</span> {t("bots.room.needsYouTitle")}
              </p>
            </Show>

            {/* The question of the member on turn, answered as in its chat (B8c). */}
            <Show when={speaking() ? asked() : undefined}>
              {(pending) => (
                <div data-slot="bots-permission" role="group" aria-label={t("bots.permission.request")}>
                  <span data-slot="bots-permission-text">
                    @{nameOf(speaking()!)} {t("bots.permission.wantsToUse")} <code>{pending().permission}</code>
                    <Show when={pending().patterns}>
                      {" "}
                      {t("bots.permission.on")} <code>{pending().patterns}</code>
                    </Show>
                    <Show when={pending().reason}>
                      {(reason) => <span data-slot="bots-permission-why">{t("bots.approval.why", reason())}</span>}
                    </Show>
                    <Show when={pending().expiresAt}>
                      <span data-slot="bots-permission-why">{t("bots.approval.timeout", APPROVAL_TIMEOUT_MS / 60_000)}</span>
                    </Show>
                  </span>
                  <span data-slot="bots-permission-actions">
                    <button type="button" data-slot="bots-btn" onClick={() => props.deps.answer(speaking()!, "reject")}>
                      {t("bots.permission.deny")}
                    </button>
                    <Show when={!pending().denyOnly && (pending().always?.length ?? 0) > 0}>
                      <button type="button" data-slot="bots-btn" onClick={() => props.deps.answer(speaking()!, "always")}>
                        {t("bots.approval.always")}
                      </button>
                    </Show>
                    <Show when={!pending().denyOnly}>
                      <button type="button" data-slot="bots-btn" data-tone="primary" onClick={() => props.deps.answer(speaking()!, "once")}>
                        {t("bots.permission.allow")}
                      </button>
                    </Show>
                  </span>
                </div>
              )}
            </Show>

            <Show when={speaking()}>
              {(path) => (
                <div data-slot="bots-typing">
                  <span>{t("bots.room.speaking", nameOf(path()))}</span>
                  <button type="button" data-slot="bots-link" onClick={() => props.deps.stop(current().id)}>
                    {t("bots.room.stop")}
                  </button>
                </div>
              )}
            </Show>

            <Show when={current().note}>{(note) => <p data-slot="bots-problem">{note()}</p>}</Show>
          </div>

          <div data-slot="bots-mentions">
            <For each={[...current().members.map(nameOf), t("bots.room.everyone"), t("bots.room.user")]}>
              {(name) => (
                <button
                  type="button"
                  data-slot="bots-mention"
                  onClick={() => {
                    setDraft((text) => (text.trim().length > 0 ? `${text.trimEnd()} @${name} ` : `@${name} `))
                    field?.focus()
                  }}
                >
                  @{name}
                </button>
              )}
            </For>
          </div>

          <form
            data-slot="bots-composer"
            onSubmit={(event) => {
              event.preventDefault()
              void submit()
            }}
          >
            <textarea
              ref={(el) => (field = el)}
              data-slot="bots-composer-field"
              rows="1"
              value={draft()}
              placeholder={t("bots.room.placeholder")}
              onInput={(event) => setDraft(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
                  event.preventDefault()
                  void submit()
                }
              }}
            />
            <button type="submit" data-slot="bots-btn" data-tone="primary" disabled={draft().trim().length === 0}>
              {t("bots.send")}
            </button>
          </form>
        </div>
      )}
    </Show>
  )
}

/** The form that makes a room: a name, two to six bots, and a cap per round when money is involved. */
export function RoomForm(props: { deps: RoomPanelDeps; onCreated: (id: string) => void; onCancel: () => void }) {
  const [name, setName] = createSignal("")
  const [members, setMembers] = createSignal<readonly string[]>([])
  const [cap, setCap] = createSignal("")
  const [problem, setProblem] = createSignal<string>()
  const [saving, setSaving] = createSignal(false)

  const toggle = (path: string, on: boolean) => {
    setMembers((all) => (on ? [...all, path] : all.filter((entry) => entry !== path)))
    setProblem(undefined)
  }

  const submit = async (event: Event) => {
    event.preventDefault()
    if (saving()) return
    const trimmed = name().trim()
    if (trimmed.length === 0) return setProblem(t("bots.room.form.noName"))
    const usd = cap().trim().length > 0 ? Number(cap().replace(",", ".")) : undefined
    setSaving(true)
    try {
      const made = await props.deps.create({
        name: trimmed,
        members: members(),
        ...(usd !== undefined ? { spend: { perRoundUsd: usd } } : {}),
      })
      if ("problem" in made) setProblem(made.problem)
      else props.onCreated(made.id)
    } finally {
      setSaving(false)
    }
  }

  return (
    <form data-slot="bots-form" onSubmit={(event) => void submit(event)}>
      <h2 data-slot="bots-form-title">{t("bots.room.new")}</h2>
      <label data-slot="bots-field">
        <span data-slot="bots-label">{t("bots.room.form.name")}</span>
        <input
          data-slot="bots-input"
          value={name()}
          onInput={(event) => {
            setName(event.currentTarget.value)
            setProblem(undefined)
          }}
          placeholder={t("bots.room.form.namePlaceholder")}
        />
      </label>
      <div data-slot="bots-field">
        <span data-slot="bots-label">{t("bots.room.form.members", MIN_MEMBERS, MAX_MEMBERS)}</span>
        <div data-slot="room-pick">
          <For each={props.deps.bots().filter((bot) => bot.mode !== "subagent")}>
            {(bot) => (
              <label data-slot="room-pick-row">
                <input
                  type="checkbox"
                  checked={members().includes(bot.path)}
                  onChange={(event) => toggle(bot.path, event.currentTarget.checked)}
                />
                <span>@{bot.identifier}</span>
                <span data-slot="bots-hint">{bot.model || bot.runner}</span>
              </label>
            )}
          </For>
        </div>
      </div>
      <label data-slot="bots-field">
        <span data-slot="bots-label">{t("bots.room.form.cap")}</span>
        <input
          data-slot="bots-input"
          inputmode="decimal"
          value={cap()}
          onInput={(event) => {
            setCap(event.currentTarget.value)
            setProblem(undefined)
          }}
          placeholder="0.10"
        />
        <span data-slot="bots-hint">{t("bots.room.form.capHint", ROOM_ROUND_MAX_USD)}</span>
      </label>
      <div data-slot="bots-form-actions">
        <Show when={problem()}>{(text) => <span data-slot="bots-problem">{text()}</span>}</Show>
        <button type="button" data-slot="bots-btn" onClick={() => props.onCancel()}>
          {t("bots.room.form.cancel")}
        </button>
        <button type="submit" data-slot="bots-btn" data-tone="primary" disabled={saving()}>
          {t("bots.room.form.create")}
        </button>
      </div>
    </form>
  )
}
