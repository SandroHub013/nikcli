/**
 * The chat section: a conversation with nikcli in the open project (C4).
 *
 * Everything comes from the chat's store (`store.ts`): the folder's sessions,
 * their messages as the server's events build them, the permission requests
 * and the questions waiting. Leaving the section leaves the store running, so
 * an answer goes on and is there on the way back. The direct OpenRouter path
 * (`client.ts`) is no longer used here; C8 takes it out.
 *
 * Everything worth asserting is in the sibling `.ts` files: `sessions.ts` for
 * the list and the open session, `view.ts` for parts and cards, `store.ts`
 * for the calls. A `.tsx` cannot be imported under `bun test` here, so
 * nothing that matters is allowed to live in this file.
 */

import { createEffect, createMemo, createSignal, on, For, Show, onMount } from "solid-js"
import { t } from "../i18n"
import type { Agent, ProviderList } from "@nikcli-ai/sdk/client"
import type { ChatCatalog } from "./connection"
import {
  agentsFromList,
  defaultAgentChoice,
  defaultModelChoice,
  isAdeTestBuild,
  modelsFromProviderList,
  sameModel,
  serializeModelRef,
  validateSelectedModel,
  type ChatAgentChoice,
  type ChatModelChoice,
  type ModelRef,
} from "./model"
import { MessageParts, PermissionCard, QuestionCard, RulesNote } from "./parts"
import { isOpenOn, useFolder } from "./first-use"
import { stopAnswer } from "./stop"
import {
  addAttachment,
  attachmentFor,
  attachmentParts,
  completeMention,
  isEnvFile,
  mentionAt,
  type Attachment,
} from "./attachments"
import { composerAction, liveAnnouncement } from "./composer"
import { forgetLegacyConversation } from "./legacy"
import { requestProblem, retryNotice } from "./errors"
import { answerUsage, answerUsageText, sessionUsage, sessionUsageText } from "./usage"
import { SessionList } from "./session-list"
import {
  connectionNotice,
  conversationOf,
  isBusy,
  messageError,
  partsOf,
  followOpen,
  sessionEntries,
  type OpenSession,
  type Turn,
} from "./sessions"
import { appChatStore, type ChatStore } from "./store"
import "./chat.css"

const MODEL_KEY = "ade.chat.model"
const AGENT_KEY = "ade.chat.agent"
// The direct path's old conversation (`legacy.ts`) goes the first time the Chat starts in this window.
let legacyForgotten = false

const STATUS = {
  noProject: "chat.status.noProject",
  notOpen: "chat.status.notOpen",
  admitting: "chat.status.admitting",
  connecting: "chat.status.connecting",
  retrying: "chat.status.retrying",
} as const

export interface ChatProps {
  /** The open project: the chat works in its folder, once it is trusted. */
  projectRoot?: string
  /** The window's store unless a caller brings one. */
  store?: ChatStore
  /** Injected by tests or callers */
  providerList?: ProviderList
  /** Injected by tests or callers */
  agents?: readonly Agent[]
  /** Override for ADE Test mode (auto-detected if undefined) */
  isTest?: boolean
}

function loadStoredModel(
  models: readonly ChatModelChoice[],
  isTest: boolean,
  configModel?: string | null,
): ModelRef | undefined {
  try {
    const stored = localStorage.getItem(MODEL_KEY)
    const validated = validateSelectedModel(stored, models, isTest)
    if (validated) return validated
  } catch {}
  const def = defaultModelChoice(models, configModel)
  return def ? { providerID: def.providerID, modelID: def.modelID } : undefined
}

function loadStoredAgent(agents: readonly ChatAgentChoice[]): string {
  try {
    const stored = localStorage.getItem(AGENT_KEY)
    if (stored && agents.some((a) => a.name === stored)) return stored
  } catch {}
  return defaultAgentChoice(agents) ?? ""
}

export function Chat(props: ChatProps) {
  const store = props.store ?? appChatStore()
  const isTest = () => props.isTest ?? isAdeTestBuild()
  const [draft, setDraft] = createSignal("")
  const [models, setModels] = createSignal<readonly ChatModelChoice[]>(
    modelsFromProviderList(props.providerList, { isTest: isTest() }),
  )
  const [agents, setAgents] = createSignal<readonly ChatAgentChoice[]>(agentsFromList(props.agents))
  const [model, setModel] = createSignal<ModelRef | undefined>(loadStoredModel(models(), isTest()))
  const [agent, setAgent] = createSignal<string>(loadStoredAgent(agents()))
  const [opened, setOpened] = createSignal<OpenSession>({ seen: false })
  const setCurrent = (id: string | undefined) => setOpened({ id, seen: false })
  const [sending, setSending] = createSignal(false)
  const [problem, setProblem] = createSignal<string>()

  let scroller: HTMLDivElement | undefined
  let composer: HTMLTextAreaElement | undefined
  // Files that go with the next message (C6): the project's only (`attachments.ts`).
  const [attachments, setAttachments] = createSignal<readonly Attachment[]>([])
  // The `@` word being typed, and the project files that match it.
  const [mention, setMention] = createSignal<{ start: number; query: string }>()
  const [mentionResults, setMentionResults] = createSignal<readonly string[]>([])
  const [mentionIndex, setMentionIndex] = createSignal(0)
  let mentionAsk = 0
  let mentionTimer: ReturnType<typeof setTimeout> | undefined
  // When the open session was put on screen: answers finished before it are not read out again.
  let shownSince = Date.now()

  /**
   * C3's models and agents, from the catalog the store loads through the
   * folder's own connection (C4): the same admission, no second one.
   */
  const applyCatalog = (catalog: ChatCatalog) => {
    const testBuild = isTest()
    const resolvedModels = modelsFromProviderList(catalog.providerList ?? props.providerList, { isTest: testBuild })
    setModels(resolvedModels)
    const resolvedAgents = agentsFromList(catalog.agents ?? props.agents)
    setAgents(resolvedAgents)
    setModel(
      (current) =>
        validateSelectedModel(current, resolvedModels, testBuild) ??
        loadStoredModel(resolvedModels, testBuild, catalog.configModel),
    )
    setAgent((current) => (resolvedAgents.some((a) => a.name === current) ? current : loadStoredAgent(resolvedAgents)))
  }

  /**
   * A use of the chat: a picker opened, a message sent, «Collega» pressed.
   * Only here does the chat admit and open the project and read its catalog
   * (`first-use.ts`); showing the section calls nothing (C9).
   */
  const use = () => useFolder(store, props.projectRoot, applyCatalog)

  onMount(() => {
    if (!legacyForgotten) {
      legacyForgotten = true
      forgetLegacyConversation()
    }
    composer?.focus()
    // Back to a folder already in use: its catalog is the store's, kept per opening.
    if (isOpenOn(store, props.projectRoot)) void use()
  })

  // Another project: its sessions are not the ones open here.
  createEffect(
    on(
      () => props.projectRoot,
      (_root, previous) => {
        if (previous !== undefined) {
          setCurrent(undefined)
          setAttachments([])
        }
      },
      { defer: true },
    ),
  )

  const entries = createMemo(() =>
    isOpenOn(store, props.projectRoot) ? sessionEntries(store.state.data, store.state.directory) : [],
  )
  createEffect(
    on(entries, (list) => {
      const next = followOpen(list, opened())
      if (next.id !== opened().id || next.seen !== opened().seen) setOpened(next)
    }),
  )
  const open = () => opened().id
  const entry = () => entries().find((item) => item.id === open())
  const turns = createMemo<Turn[]>(() => {
    const id = open()
    return id ? conversationOf(store.state.data, id) : []
  })
  // What the open session has cost, and how full the model's window is when the catalog knows its size.
  const usageLine = () => {
    const list = turns()
    if (!list.some((turn) => turn.info.role === "assistant")) return undefined
    const usage = sessionUsage(list.map((turn) => turn.info))
    const context = usage.context
    const limit = context
      ? models().find((entry) => entry.providerID === context.providerID && entry.modelID === context.modelID)?.context
      : undefined
    return sessionUsageText(usage, limit)
  }
  const permissions = () => {
    const id = open()
    return id ? (store.state.data.permission[id] ?? []) : []
  }
  const questions = () => {
    const id = open()
    return id ? (store.state.data.question[id] ?? []) : []
  }
  // The provider failed mid-answer and nikcli tries again: said, rather than a caret that just waits.
  const retrying = () => {
    const id = open()
    return id ? retryNotice(store.state.data.session_status[id]) : undefined
  }
  const answering = () => {
    const id = open()
    return id ? isBusy(store.state.data, id) : false
  }
  const notice = () => connectionNotice(store.state, props.projectRoot)
  // A session made outside the chat is read, never written to (C5).
  const foreign = () => entry() !== undefined && !entry()!.chat
  // The first message is a use too: it opens the folder, then goes. The stream follows it.
  const canSend = () => !!props.projectRoot && store.state.status !== "refused" && !foreign() && !sending()

  createEffect(
    on([() => turns().length, () => turns().at(-1)?.parts.length, permissions, questions], () => {
      const node = scroller
      if (!node) return
      const distanceFromBottom = node.scrollHeight - node.scrollTop - node.clientHeight
      if (distanceFromBottom < 140) node.scrollTop = node.scrollHeight
    }),
  )

  const openSession = (sessionID: string) => {
    shownSince = Date.now()
    setCurrent(sessionID)
    setProblem(undefined)
    void store
      .loadMessages(sessionID)
      .catch((error: unknown) => setProblem(requestProblem(error)))
  }

  const closeMention = () => {
    mentionAsk++
    clearTimeout(mentionTimer)
    setMention(undefined)
    setMentionResults([])
  }

  // Typing `@` is a use: it opens the folder if needed, then asks the server for its files.
  const lookUp = (value: string, caret: number) => {
    const found = props.projectRoot && !foreign() ? mentionAt(value, caret) : undefined
    if (!found) return closeMention()
    setMention(found)
    const ask = ++mentionAsk
    clearTimeout(mentionTimer)
    mentionTimer = setTimeout(() => {
      void (async () => {
        if (!(await use())) return
        const paths = await store.findFiles(found.query).catch(() => [] as string[])
        if (ask !== mentionAsk) return
        setMentionResults(paths.filter((path) => !isEnvFile(path)))
        setMentionIndex(0)
      })()
    }, 120)
  }

  const pickMention = (relative: string | undefined) => {
    const found = mention()
    const root = props.projectRoot
    closeMention()
    if (!relative || !found || !root || !composer) return
    if (isEnvFile(relative)) {
      setProblem(t("chat.attach.env", relative))
      return
    }
    const file = attachmentFor(root, relative)
    if (!file) {
      setProblem(t("chat.attach.outside", relative))
      return
    }
    const next = completeMention(draft(), found, composer.selectionStart ?? draft().length, file.relative)
    setDraft(next.text)
    setAttachments((list) => addAttachment(list, file))
    queueMicrotask(() => composer?.setSelectionRange(next.caret, next.caret))
  }

  const attach = async () => {
    const root = props.projectRoot
    if (!root) return
    let picked: string | string[] | null = null
    try {
      const dialog = await import("@tauri-apps/plugin-dialog")
      picked = await dialog.open({ multiple: true, directory: false, defaultPath: root, title: t("chat.attach.addHint") })
    } catch {
      return
    }
    setProblem(undefined)
    for (const path of picked === null ? [] : Array.isArray(picked) ? picked : [picked]) {
      const file = isEnvFile(path) ? undefined : attachmentFor(root, path)
      if (file) setAttachments((list) => addAttachment(list, file))
      else setProblem(t(isEnvFile(path) ? "chat.attach.env" : "chat.attach.outside", path))
    }
    composer?.focus()
  }

  const live = createMemo(() => liveAnnouncement(turns(), shownSince)?.text ?? "")

  const newSession = () => {
    setCurrent(undefined)
    setProblem(undefined)
    composer?.focus()
  }

  const send = async () => {
    const text = draft().trim()
    if (!text || !canSend()) return
    setSending(true)
    setProblem(undefined)
    try {
      if (!(await use())) return
      const ref = model()
      if (!ref) {
        setProblem(t("chat.model.choose"))
        return
      }
      const id = await store.send(open(), text, ref, agent() || undefined, attachmentParts(attachments()))
      setCurrent(id)
      setDraft("")
      setAttachments([])
    } catch (error) {
      setProblem(requestProblem(error))
    } finally {
      setSending(false)
      composer?.focus()
    }
  }

  const stop = () => {
    setProblem(undefined)
    void stopAnswer(store, open(), setProblem)
  }

  const chooseModel = (raw: string) => {
    const validated = validateSelectedModel(raw, models(), isTest())
    if (!validated) return
    setModel(validated)
    try {
      localStorage.setItem(MODEL_KEY, JSON.stringify(validated))
    } catch {
      // This session keeps the choice regardless.
    }
  }

  const chooseAgent = (name: string) => {
    setAgent(name)
    try {
      localStorage.setItem(AGENT_KEY, name)
    } catch {
      // This session keeps the choice regardless.
    }
  }

  const onKeyDown = (event: KeyboardEvent) => {
    const results = mentionResults()
    const action = composerAction(event, mention() !== undefined && results.length > 0)
    if (action === "none") return
    event.preventDefault()
    if (action === "send") void send()
    else if (action === "mentionNext") setMentionIndex((index) => (index + 1) % results.length)
    else if (action === "mentionPrevious") setMentionIndex((index) => (index - 1 + results.length) % results.length)
    else if (action === "mentionPick") pickMention(results[mentionIndex()])
    else closeMention()
  }

  return (
    <section data-component="ade-chat">
      <header data-slot="chat-head">
        <div data-slot="chat-selectors">
          <select
            data-slot="chat-agent"
            value={agent() || ""}
            onFocus={() => void use()}
            onChange={(event) => chooseAgent(event.currentTarget.value)}
            aria-label={t("chat.agent.label")}
          >
            <Show when={agents().length === 0}>
              <option value="" disabled selected>
                {t("chat.agent.none")}
              </option>
            </Show>
            <For each={agents()}>{(entry) => <option value={entry.name}>{entry.name}</option>}</For>
            <Show when={agent() && !agents().some((entry) => entry.name === agent())}>
              <option value={agent()}>{agent()}</option>
            </Show>
          </select>

          <select
            data-slot="chat-model"
            value={model() ? serializeModelRef(model()!) : ""}
            onFocus={() => void use()}
            onChange={(event) => chooseModel(event.currentTarget.value)}
            aria-label={t("chat.model.label")}
          >
            <Show when={models().length === 0}>
              <option value="" disabled selected>
                {t("chat.model.none")}
              </option>
            </Show>
            <Show when={models().length > 0 && !model()}>
              <option value="" disabled selected>
                {t("chat.model.choose")}
              </option>
            </Show>
            <For each={models()}>{(entry) => <option value={serializeModelRef(entry)}>{entry.label}</option>}</For>
            <Show when={model() && !models().some((entry) => sameModel(entry, model()))}>
              <option value={serializeModelRef(model()!)}>{serializeModelRef(model()!)}</option>
            </Show>
          </select>
        </div>
        <div data-slot="chat-head-actions">
          <button type="button" data-slot="chat-action" disabled={open() === undefined} onClick={newSession}>
            {t("chat.new")}
          </button>
        </div>
      </header>

      <div data-slot="chat-main">
        <SessionList
          entries={entries()}
          current={open()}
          onOpen={openSession}
          onRename={(id, title) => store.rename(id, title)}
        />

        <div data-slot="chat-column">
          <RulesNote />

          <Show when={notice()}>
            {(shown) => (
              <p data-slot="chat-notice" role="status">
                {(() => {
                  const now = shown()
                  return now.kind === "refused" ? (now.problem ?? t("chat.status.refused")) : t(STATUS[now.kind])
                })()}
                <Show when={shown().kind === "notOpen"}>
                  {" "}
                  <button type="button" data-slot="chat-link" onClick={() => void use()}>
                    {t("chat.connect")}
                  </button>
                </Show>
              </p>
            )}
          </Show>
          <Show when={foreign()}>
            <p data-slot="chat-notice">
              {t("chat.foreignSession")}{" "}
              <button type="button" data-slot="chat-link" onClick={newSession}>
                {t("chat.new")}
              </button>
            </p>
          </Show>

          <Show when={usageLine()}>{(line) => <p data-slot="chat-usage-session">{line()}</p>}</Show>

          <div data-slot="chat-scroll" ref={(el) => (scroller = el)}>
            <Show
              when={turns().length > 0}
              fallback={
                <div data-slot="chat-empty">
                  <p data-slot="chat-empty-title">{t("chat.empty.title")}</p>
                  <p data-slot="chat-empty-body">{t("chat.empty.body")}</p>
                </div>
              }
            >
              <For each={turns()}>{(turn) => <Turn turn={turn} />}</For>
            </Show>
            <Show when={retrying()}>
              {(line) => (
                <p data-slot="chat-retry" role="status">
                  {line()}
                </p>
              )}
            </Show>
            <For each={permissions()}>
              {(request) => (
                <PermissionCard
                  request={request}
                  parts={partsOf(store.state.data, request.sessionID)}
                  onReply={(reply) => store.replyPermission(request.id, reply)}
                />
              )}
            </For>
            <For each={questions()}>
              {(request) => (
                <QuestionCard
                  request={request}
                  onAnswer={(answers) => store.answerQuestion(request.id, answers)}
                  onReject={() => store.rejectQuestion(request.id)}
                />
              )}
            </For>
          </div>

          <Show when={problem()}>{(message) => <p data-slot="chat-error">{message()}</p>}</Show>

          <Show when={attachments().length > 0}>
            <ul data-slot="chat-attachments" aria-label={t("chat.attach.list")}>
              <For each={attachments()}>
                {(file) => (
                  <li data-slot="chat-attachment">
                    <span data-slot="chat-attachment-name">{file.relative}</span>
                    <button
                      type="button"
                      data-slot="chat-attachment-remove"
                      aria-label={t("chat.attach.remove", file.relative)}
                      title={t("chat.attach.remove", file.relative)}
                      onClick={() => setAttachments((list) => list.filter((item) => item.path !== file.path))}
                    >
                      ×
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </Show>
          <Show when={mention()}>
            <ul data-slot="chat-mentions" id="chat-mentions" role="listbox" aria-label={t("chat.mention.list")}>
              <Show
                when={mentionResults().length > 0}
                fallback={<li data-slot="chat-mention-none">{t("chat.mention.none")}</li>}
              >
                <For each={mentionResults()}>
                  {(path, index) => (
                    <li
                      data-slot="chat-mention"
                      id={`chat-mention-${index()}`}
                      role="option"
                      aria-selected={index() === mentionIndex()}
                      // Before the textarea blurs: the choice lands in it, with the focus.
                      onMouseDown={(event) => {
                        event.preventDefault()
                        pickMention(path)
                      }}
                    >
                      {path}
                    </li>
                  )}
                </For>
              </Show>
            </ul>
          </Show>

          <div data-slot="chat-composer">
            <button
              type="button"
              data-slot="chat-attach"
              title={t("chat.attach.addHint")}
              disabled={!props.projectRoot || foreign()}
              onClick={() => void attach()}
            >
              {t("chat.attach.add")}
            </button>
            <textarea
              ref={(el) => (composer = el)}
              data-slot="chat-input"
              rows="1"
              placeholder={t("chat.input.placeholder")}
              value={draft()}
              disabled={foreign()}
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={mention() !== undefined}
              aria-controls={mention() ? "chat-mentions" : undefined}
              aria-activedescendant={
                mention() && mentionResults().length > 0 ? `chat-mention-${mentionIndex()}` : undefined
              }
              onInput={(event) => {
                setDraft(event.currentTarget.value)
                lookUp(event.currentTarget.value, event.currentTarget.selectionStart ?? event.currentTarget.value.length)
              }}
              onBlur={closeMention}
              onKeyDown={onKeyDown}
            />
            <Show
              when={answering() && !foreign()}
              fallback={
                <button
                  type="button"
                  data-slot="chat-send"
                  disabled={!draft().trim() || !canSend()}
                  onClick={() => void send()}
                >
                  {t("chat.send")}
                </button>
              }
            >
              <button type="button" data-slot="chat-send" data-stop="true" onClick={stop}>
                {t("chat.stop")}
              </button>
            </Show>
          </div>
        </div>
      </div>
      {/* What a screen reader hears when an answer is finished (`composer.ts`). */}
      <p data-slot="chat-live" aria-live="polite">
        {live()}
      </p>
    </section>
  )
}

function Turn(props: { turn: Turn }) {
  const role = () => props.turn.info.role
  return (
    <article data-slot="chat-message" data-role={role()}>
      <Show when={role() === "assistant"}>
        <span data-slot="chat-author">nik</span>
      </Show>
      <div data-slot="chat-body">
        <MessageParts parts={props.turn.parts} />
        {/* The cursor is the only signal that a silent model is still thinking
            rather than finished with nothing to say. */}
        <Show
          when={
            role() === "assistant" &&
            !(props.turn.info as { time?: { completed?: number } }).time?.completed &&
            props.turn.parts.length === 0
          }
        >
          <span data-slot="chat-caret" aria-label={t("chat.writing")} />
        </Show>
        <Show when={messageError(props.turn.info)}>
          {(error) => (
            <p data-slot="chat-error">
              {error().text}
              <Show when={error().detail}>
                {(detail) => <span data-slot="chat-error-detail">{detail()}</span>}
              </Show>
            </p>
          )}
        </Show>
        <Show when={answerUsage(props.turn.info)}>
          {(usage) => <p data-slot="chat-usage">{answerUsageText(usage())}</p>}
        </Show>
      </div>
    </article>
  )
}
