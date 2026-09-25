/**
 * A message's parts, a permission request and a question, drawn (C5).
 *
 * Everything shown comes from the model or the project, and goes into text
 * nodes only: no `innerHTML`, no markup parsed from a reply (`view.ts` makes
 * the strings, `html-sinks.test.ts` keeps it so). The cards answer through
 * the callbacks they are given, which are the store's (`store.ts`): the
 * answer is the server's to act on, and the card waits for it to arrive.
 */

import { createSignal, For, Index, Match, Show, Switch } from "solid-js"
import type { Part, PermissionRequest, QuestionRequest } from "@nikcli-ai/sdk/httpapi"
import { t } from "../i18n"
import { CodeBlock } from "./code-block"
import {
  allowsTyping,
  answersOf,
  emptyDraft,
  OUTPUT_LIMIT,
  partView,
  permissionView,
  pick,
  type as typeAnswer,
  type PartView,
  type ToolStatus,
} from "./view"

const STATUS = {
  pending: "chat.tool.pending",
  running: "chat.tool.running",
  completed: "chat.tool.completed",
  error: "chat.tool.error",
} as const satisfies Record<ToolStatus, string>

export function MessageParts(props: { parts: readonly Part[] }) {
  const views = () => props.parts.map(partView).filter((view): view is PartView => view !== undefined)
  return <For each={views()}>{(view) => <PartBlock view={view} />}</For>
}

function PartBlock(props: { view: PartView }) {
  return (
    <Switch>
      <Match when={props.view.kind === "text" ? props.view : undefined}>
        {(view) => (
          <For each={view().segments}>
            {(segment) =>
              segment.kind === "code" ? (
                <CodeBlock language={segment.language} text={segment.text} />
              ) : (
                <p data-slot="chat-prose">{segment.text}</p>
              )
            }
          </For>
        )}
      </Match>
      <Match when={props.view.kind === "reasoning" ? props.view : undefined}>
        {(view) => (
          <details data-slot="chat-reasoning">
            <summary>{t("chat.reasoning")}</summary>
            <p data-slot="chat-reasoning-text">{view().text}</p>
          </details>
        )}
      </Match>
      <Match when={props.view.kind === "tool" ? props.view : undefined}>
        {(view) => (
          <details data-slot="chat-tool" data-status={view().status}>
            <summary>
              <span data-slot="chat-tool-name">{view().tool}</span>
              <span data-slot="chat-tool-subject">{view().subject}</span>
              <span data-slot="chat-tool-status">{t(STATUS[view().status])}</span>
            </summary>
            <Show when={view().output}>{(output) => <pre data-slot="chat-tool-output">{output()}</pre>}</Show>
            <Show when={view().cut}>
              <p data-slot="chat-tool-note">{t("chat.tool.cut", OUTPUT_LIMIT)}</p>
            </Show>
            <Show when={view().error}>{(error) => <p data-slot="chat-error">{error()}</p>}</Show>
          </details>
        )}
      </Match>
      <Match when={props.view.kind === "file" ? props.view : undefined}>
        {(view) => <p data-slot="chat-file">{t("chat.file", view().name)}</p>}
      </Match>
    </Switch>
  )
}

/** Runs `answer` once at a time; says so when it did not reach the server. */
function useAnswer() {
  const [busy, setBusy] = createSignal(false)
  const [failed, setFailed] = createSignal(false)
  const run = async (answer: () => Promise<void>) => {
    if (busy()) return
    setBusy(true)
    setFailed(false)
    try {
      await answer()
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }
  return { busy, failed, run }
}

/** «Yes this once» or «no». «Always» is not offered: it would outlive the chat's own rules (`rules.ts`). */
export function PermissionCard(props: { request: PermissionRequest; onReply: (reply: "once" | "reject") => Promise<void> }) {
  const view = () => permissionView(props.request)
  const answer = useAnswer()
  return (
    <section data-slot="chat-permission" role="group" aria-label={t("chat.permission.label")}>
      <p data-slot="chat-permission-title">{t("chat.permission.ask", view().permission)}</p>
      <For each={view().patterns}>{(pattern) => <code data-slot="chat-permission-pattern">{pattern}</code>}</For>
      <div data-slot="chat-permission-actions">
        <button type="button" data-slot="chat-action" disabled={answer.busy()} onClick={() => void answer.run(() => props.onReply("once"))}>
          {t("chat.permission.once")}
        </button>
        <button
          type="button"
          data-slot="chat-action"
          data-tone="danger"
          disabled={answer.busy()}
          onClick={() => void answer.run(() => props.onReply("reject"))}
        >
          {t("chat.permission.reject")}
        </button>
      </div>
      <Show when={answer.failed()}>
        <p data-slot="chat-error">{t("chat.answer.failed")}</p>
      </Show>
    </section>
  )
}

export function QuestionCard(props: {
  request: QuestionRequest
  onAnswer: (answers: string[][]) => Promise<void>
  onReject: () => Promise<void>
}) {
  const [draft, setDraft] = createSignal(emptyDraft(props.request))
  const answers = () => answersOf(draft(), props.request)
  const answer = useAnswer()
  return (
    <section data-slot="chat-question" role="group" aria-label={t("chat.question.label")}>
      <Index each={props.request.questions}>
        {(question, index) => (
          <fieldset data-slot="chat-question-item">
            <legend data-slot="chat-question-head">{question().header}</legend>
            <p data-slot="chat-question-text">{question().question}</p>
            <div data-slot="chat-question-options">
              <For each={question().options}>
                {(option) => (
                  <button
                    type="button"
                    data-slot="chat-option"
                    aria-pressed={draft().chosen[index]?.includes(option.label) ?? false}
                    title={option.description}
                    onClick={() => setDraft(pick(draft(), props.request, index, option.label))}
                  >
                    {option.label}
                  </button>
                )}
              </For>
            </div>
            <Show when={allowsTyping(props.request, index)}>
              <input
                type="text"
                data-slot="chat-question-typed"
                placeholder={t("chat.question.typed")}
                value={draft().typed[index] ?? ""}
                onInput={(event) => setDraft(typeAnswer(draft(), index, event.currentTarget.value))}
              />
            </Show>
          </fieldset>
        )}
      </Index>
      <div data-slot="chat-permission-actions">
        <button
          type="button"
          data-slot="chat-action"
          disabled={answer.busy() || !answers()}
          onClick={() => {
            const chosen = answers()
            if (chosen) void answer.run(() => props.onAnswer(chosen))
          }}
        >
          {t("chat.question.send")}
        </button>
        <button type="button" data-slot="chat-action" disabled={answer.busy()} onClick={() => void answer.run(props.onReject)}>
          {t("chat.question.reject")}
        </button>
      </div>
      <Show when={answer.failed()}>
        <p data-slot="chat-error">{t("chat.answer.failed")}</p>
      </Show>
    </section>
  )
}
