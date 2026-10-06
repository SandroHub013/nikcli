/**
 * The chat's errors in words (C7), in the language ADE speaks.
 *
 * An answer that fails carries nikcli's error on its message, by name
 * (`MessageV2.AssistantErrorSchema`): the kind is said here in a sentence, and
 * what the provider said, when it said something useful, follows it as a
 * detail — «rate-limited upstream» is worth reading verbatim. A request that
 * fails (sending, loading, renaming) comes as the SDK's parsed error body, an
 * `Error`, or the Rust bridge's string, and gets the same treatment.
 *
 * Everything returned is text: it goes into text nodes only.
 */

import type { SessionStatus } from "@nikcli-ai/sdk/httpapi"
import { t } from "../i18n"

export interface ErrorView {
  readonly text: string
  readonly detail?: string
}

type Raw = {
  name?: unknown
  message?: unknown
  data?: {
    message?: unknown
    statusCode?: unknown
    responseBody?: unknown
    classification?: unknown
  }
}

/** Long enough for a provider's sentence, short enough not to fill the column. */
const DETAIL_MAX = 300

function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > DETAIL_MAX ? `${flat.slice(0, DETAIL_MAX - 1)}…` : flat
}

/**
 * The provider's own words from an API error: OpenRouter nests the useful
 * sentence in `error.metadata.raw`, others in `error.message`. Only those
 * fields are read: the rest of the body (ids of the account, headers) is not
 * shown.
 */
function providerWords(data: Raw["data"]): string | undefined {
  if (typeof data?.responseBody === "string") {
    try {
      const body = JSON.parse(data.responseBody) as { error?: { message?: unknown; metadata?: { raw?: unknown } } }
      const raw = body.error?.metadata?.raw
      if (typeof raw === "string" && raw.trim()) return raw
      const message = body.error?.message
      if (typeof message === "string" && message.trim()) return message
    } catch {
      // Not JSON: the message below will have to do.
    }
  }
  return typeof data?.message === "string" && data.message.trim() ? data.message : undefined
}

function withDetail(text: string, detail: string | undefined): ErrorView {
  return detail ? { text, detail: clip(detail) } : { text }
}

function apiError(data: Raw["data"]): ErrorView {
  const status = typeof data?.statusCode === "number" ? data.statusCode : undefined
  const words = providerWords(data)
  if (data?.classification === "payload-too-large" || status === 413) return withDetail(t("chat.error.tooLarge"), words)
  if (status === 401 || status === 403) return withDetail(t("chat.error.auth"), words)
  if (status === 402) return withDetail(t("chat.error.credit"), words)
  if (status === 404) return withDetail(t("chat.error.modelMissing"), words)
  if (status === 429) return withDetail(t("chat.error.rateLimit"), words)
  if (status !== undefined && status >= 500) return withDetail(t("chat.error.providerDown"), words)
  return withDetail(status !== undefined ? t("chat.error.apiStatus", status) : t("chat.error.api"), words)
}

/** What went wrong in an answer, in words; nothing when it did not. */
export function answerError(error: unknown): ErrorView | undefined {
  if (!error || typeof error !== "object") return undefined
  const raw = error as Raw
  const message = typeof raw.data?.message === "string" ? raw.data.message : undefined
  switch (raw.name) {
    case "MessageAbortedError":
      return { text: t("chat.error.aborted") }
    case "MessageOutputLengthError":
      return { text: t("chat.error.outputLength") }
    case "MessageContextOverflowError":
      return { text: t("chat.error.contextOverflow") }
    case "ProviderAuthError":
      return withDetail(t("chat.error.auth"), message)
    case "StructuredOutputError":
      return withDetail(t("chat.error.structured"), message)
    case "APIError":
      return apiError(raw.data)
    default:
      return withDetail(t("chat.error.unknown"), message)
  }
}

/** The provider failed mid-answer and nikcli is trying again: said, with which attempt. */
export function retryNotice(status: SessionStatus | undefined): string | undefined {
  return status?.type === "retry" ? t("chat.retry", status.attempt) : undefined
}

/** A request that failed, in one line for the composer; `ForeignSession` and the chat's own errors keep their words. */
export function requestProblem(error: unknown): string {
  if (error instanceof DOMException && error.name === "AbortError") return t("chat.error.aborted")
  // The Rust bridge rejects with its own words: the server could not be reached.
  if (typeof error === "string") return line(withDetail(t("chat.error.server"), error))
  if (error instanceof TypeError && /fetch|network/i.test(error.message)) return t("chat.error.server")
  if (error instanceof Error) return error.message || t("chat.error.unknown")
  // The SDK throws the server's parsed error body.
  if (error && typeof error === "object") {
    const raw = error as Raw
    if (typeof raw.name === "string") return line(answerError(error)!)
    const message = raw.data?.message ?? raw.message
    if (typeof message === "string" && message.trim()) return line(withDetail(t("chat.error.unknown"), message))
  }
  return t("chat.error.unknown")
}

function line(view: ErrorView): string {
  return view.detail ? `${view.text} (${view.detail})` : view.text
}
