/**
 * The chat section: a conversation with a language model, no terminal behind it.
 *
 * This is the one part of ADE with no agent and no process. It exists for the
 * questions that come before the work — how does this API behave, what is the
 * idiomatic shape here — which today are asked in a browser tab, with the
 * project's context left behind in the other window.
 *
 * Everything worth asserting is in the sibling `.ts` files: `model.ts` for the
 * state and the stream decoder, `segments.ts` for the code-block split,
 * `client.ts` for the request. A `.tsx` cannot be imported under `bun test`
 * here, so nothing that matters is allowed to live in this file.
 */

import { createEffect, createSignal, on, For, Show, onCleanup, onMount } from "solid-js"
import { t } from "../i18n"
import {
  appendDelta,
  appendMessage,
  createChatState,
  messagesForRequest,
  settleMessage,
  modelsFromProviderList,
  agentsFromList,
  defaultModelChoice,
  defaultAgentChoice,
  isAdeTestBuild,
  validateSelectedModel,
  sameModel,
  serializeModelRef,
  parseModelRef,
  type ModelRef,
  type ChatMessage,
  type ChatState,
  type ChatModelChoice,
  type ChatAgentChoice,
} from "./model"
import { splitSegments } from "./segments"
import { streamChat, DEFAULT_CHAT_MODEL } from "./client"
import type { ProviderList, Agent, NikcliClient } from "@nikcli-ai/sdk/client"
import { openChat, appChatConnectionDeps, loadChatCatalog, type ChatConnectionDeps } from "./connection"
import "./chat.css"

const STORAGE_KEY = "ade.chat"
const MODEL_KEY = "ade.chat.model"
const AGENT_KEY = "ade.chat.agent"

export interface ChatProps {
  /** OpenRouter key, from voice settings. Empty when not configured. */
  apiKey: string
  onOpenSettings: () => void
  /** Project directory to open chat connection with trust check */
  projectRoot?: string
  /** Admitted client injected by callers or tests */
  client?: NikcliClient
  /** Connection deps override for testing openChat */
  connectionDeps?: ChatConnectionDeps
  /** Injected by tests or callers */
  providerList?: ProviderList
  /** Injected by tests or callers */
  agents?: readonly Agent[]
  /** Override for ADE Test mode (auto-detected if undefined) */
  isTest?: boolean
}

/**
 * Reads the saved conversation, tolerating anything.
 *
 * `localStorage` can be empty, stale or written by an older build, and in a
 * private window the accessor itself throws. A chat that refuses to open
 * because its history did not parse would be worse than one that starts
 * fresh, so every failure ends in the same place.
 */
function loadState(): ChatState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return createChatState()
    const parsed = JSON.parse(raw) as { messages?: unknown }
    if (!Array.isArray(parsed.messages)) return createChatState()
    const messages = parsed.messages.filter(
      (m): m is ChatMessage =>
        !!m &&
        typeof m === "object" &&
        typeof (m as ChatMessage).id === "string" &&
        typeof (m as ChatMessage).text === "string" &&
        ((m as ChatMessage).role === "user" || (m as ChatMessage).role === "assistant"),
    )
    // A message saved mid-stream is not streaming any more: the page reloaded.
    return { messages: messages.map((m) => ({ ...m, streaming: false })) }
  } catch {
    return createChatState()
  }
}

function save(state: ChatState) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    // Quota, or a browser set to block site data. The conversation still works
    // for this session; only its survival across a reload is lost.
  }
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
  const isTest = () => props.isTest ?? isAdeTestBuild()

  const initialModels = () =>
    modelsFromProviderList(props.providerList, { isTest: isTest() })
  const initialAgents = () =>
    agentsFromList(props.agents)

  const [state, setState] = createSignal<ChatState>(createChatState())
  const [draft, setDraft] = createSignal("")
  const [models, setModels] = createSignal<readonly ChatModelChoice[]>(initialModels())
  const [agents, setAgents] = createSignal<readonly ChatAgentChoice[]>(initialAgents())
  const [model, setModel] = createSignal<ModelRef | undefined>(loadStoredModel(models(), isTest()))
  const [agent, setAgent] = createSignal<string>(loadStoredAgent(agents()))
  const [busy, setBusy] = createSignal(false)

  let scroller: HTMLDivElement | undefined
  let composer: HTMLTextAreaElement | undefined
  let inFlight: AbortController | undefined

  onMount(async () => {
    setState(loadState())

    let pList = props.providerList
    let aList = props.agents
    let cfgModel: string | undefined

    let client = props.client
    if (!client && props.projectRoot) {
      try {
        const opened = await openChat(props.projectRoot, props.connectionDeps ?? appChatConnectionDeps())
        if (opened.ok) {
          client = opened.client
        }
      } catch {}
    }

    if (client) {
      try {
        const catalog = await loadChatCatalog(client)
        if (catalog.providerList) pList = catalog.providerList
        if (catalog.agents) aList = catalog.agents
        if (catalog.configModel) cfgModel = catalog.configModel
      } catch {}
    }

    const testBuild = isTest()
    const resolvedModels = modelsFromProviderList(pList, { isTest: testBuild })
    setModels(resolvedModels)

    const resolvedAgents = agentsFromList(aList)
    setAgents(resolvedAgents)

    setModel((current) => validateSelectedModel(current, resolvedModels, testBuild) ?? loadStoredModel(resolvedModels, testBuild, cfgModel))
    setAgent((current) => (resolvedAgents.some((a) => a.name === current) ? current : loadStoredAgent(resolvedAgents)))

    composer?.focus()
  })

  // Synchronous registration: an `onCleanup` after an `await` has a null owner
  // and never runs, which here would leave a request streaming into a
  // component that is gone.
  onCleanup(() => {
    inFlight?.abort()
    inFlight = undefined
  })

  createEffect(
    on([() => state().messages.length, () => state().messages.at(-1)?.text], () => {
      const node = scroller
      if (!node) return
      const distanceFromBottom = node.scrollHeight - node.scrollTop - node.clientHeight
      if (distanceFromBottom < 140) node.scrollTop = node.scrollHeight
    }),
  )

  const commit = (next: ChatState) => {
    setState(next)
    save(next)
    return next
  }

  const send = async () => {
    const text = draft().trim()
    const currentModel = model()
    if (!text || !currentModel || busy()) return

    const now = Date.now()
    const question: ChatMessage = { id: `u${now}`, role: "user", text, at: now }
    const answer: ChatMessage = { id: `a${now}`, role: "assistant", text: "", at: now, streaming: true }

    // The context is taken before the empty assistant turn is added, so the
    // request never carries a blank message of its own.
    const context = messagesForRequest(appendMessage(state(), question).messages)

    commit(appendMessage(appendMessage(state(), question), answer))
    setDraft("")
    setBusy(true)

    const controller = new AbortController()
    inFlight = controller

    try {
      await streamChat({
        apiKey: props.apiKey,
        model: DEFAULT_CHAT_MODEL,
        messages: context,
        signal: controller.signal,
        onDelta: (delta) => setState((current) => appendDelta(current, answer.id, delta)),
      })
      commit(settleMessage(state(), answer.id))
    } catch (error) {
      const aborted = controller.signal.aborted
      commit(
        settleMessage(
          state(),
          answer.id,
          aborted ? t("chat.aborted") : error instanceof Error ? error.message : t("chat.error.fallback"),
        ),
      )
    } finally {
      if (inFlight === controller) inFlight = undefined
      setBusy(false)
      composer?.focus()
    }
  }

  const stop = () => inFlight?.abort()

  const reset = () => {
    inFlight?.abort()
    commit(createChatState())
    composer?.focus()
  }

  const chooseModel = (raw: string) => {
    const validated = validateSelectedModel(raw, models(), isTest())
    if (!validated) return
    setModel(validated)
    try {
      localStorage.setItem(MODEL_KEY, JSON.stringify(validated))
    } catch {
      // Same as the conversation: this session keeps the choice regardless.
    }
  }

  const chooseAgent = (name: string) => {
    setAgent(name)
    try {
      localStorage.setItem(AGENT_KEY, name)
    } catch {
      // Same as the conversation: this session keeps the choice regardless.
    }
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault()
      if (model()) {
        void send()
      }
    }
  }

  return (
    <section data-component="ade-chat">
      <header data-slot="chat-head">
        <div data-slot="chat-selectors">
          <select
            data-slot="chat-agent"
            value={agent() || ""}
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
          <Show when={state().messages.length > 0}>
            <button type="button" data-slot="chat-action" onClick={reset}>
              {t("chat.new")}
            </button>
          </Show>
        </div>
      </header>

      <Show when={!props.apiKey}>
        <p data-slot="chat-notice">
          {t("chat.needKey")}{" "}
          <button type="button" data-slot="chat-link" onClick={() => props.onOpenSettings()}>
            {t("chat.openSettings")}
          </button>{" "}
          {t("chat.sameAsAssistant")}
        </p>
      </Show>

      <div data-slot="chat-scroll" ref={(el) => (scroller = el)}>
        <Show
          when={state().messages.length > 0}
          fallback={
            <div data-slot="chat-empty">
              <p data-slot="chat-empty-title">{t("chat.empty.title")}</p>
              <p data-slot="chat-empty-body">
                {t("chat.empty.body")}
              </p>
            </div>
          }
        >
          <For each={state().messages}>{(message) => <Bubble message={message} />}</For>
        </Show>
      </div>

      <div data-slot="chat-composer">
        <textarea
          ref={(el) => (composer = el)}
          data-slot="chat-input"
          rows="1"
          placeholder={t("chat.input.placeholder")}
          value={draft()}
          onInput={(event) => setDraft(event.currentTarget.value)}
          onKeyDown={onKeyDown}
        />
        <Show
          when={busy()}
          fallback={
            <button
              type="button"
              data-slot="chat-send"
              disabled={!draft().trim() || !model()}
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
    </section>
  )
}

function Bubble(props: { message: ChatMessage }) {
  return (
    <article data-slot="chat-message" data-role={props.message.role}>
      <Show when={props.message.role === "assistant"}>
        <span data-slot="chat-author">nik</span>
      </Show>

      <div data-slot="chat-body">
        <For each={splitSegments(props.message.text)}>
          {(segment) =>
            segment.kind === "code" ? (
              <CodeBlock language={segment.language} text={segment.text} />
            ) : (
              <p data-slot="chat-prose">{segment.text}</p>
            )
          }
        </For>

        {/* The cursor is the only signal that a silent model is still thinking
            rather than finished with nothing to say. */}
        <Show when={props.message.streaming && !props.message.text}>
          <span data-slot="chat-caret" aria-label={t("chat.writing")} />
        </Show>

        <Show when={props.message.error}>{(error) => <p data-slot="chat-error">{error()}</p>}</Show>
      </div>
    </article>
  )
}

function CodeBlock(props: { language?: string; text: string }) {
  const [copied, setCopied] = createSignal(false)
  let timer: ReturnType<typeof setTimeout> | undefined

  onCleanup(() => {
    if (timer) clearTimeout(timer)
  })

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(props.text)
      setCopied(true)
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => setCopied(false), 1600)
    } catch {
      // Clipboard denied. The text is selectable, which is the fallback.
    }
  }

  return (
    <figure data-slot="chat-code">
      <figcaption data-slot="chat-code-head">
        <span data-slot="chat-code-lang">{props.language ?? t("chat.code.text")}</span>
        <button type="button" data-slot="chat-copy" onClick={() => void copy()}>
          {copied() ? t("chat.code.copied") : t("chat.code.copy")}
        </button>
      </figcaption>
      <pre data-slot="chat-code-body">{props.text}</pre>
    </figure>
  )
}
