import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { createStore } from "solid-js/store"
import { setLocalePreference, t } from "../i18n"
import { answerError, requestProblem, retryNotice } from "./errors"
import { applyChatEvent, emptyChatData, type ChatEvent } from "./events"
import { conversationOf, messageError } from "./sessions"
import { ForeignSession } from "./store"

/* C7: errors in words, in it and en; the one that comes mid-answer is seen. */

afterEach(() => setLocalePreference("it"))

const SES = "ses_1"
const user = { id: "msg_1", sessionID: SES, role: "user", time: { created: 1 } }
const assistant = (extra: object = {}) => ({
  id: "msg_2",
  sessionID: SES,
  role: "assistant",
  time: { created: 2 },
  providerID: "openrouter",
  modelID: "a/b:free",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  ...extra,
})
const text = (value: string) => ({ id: "prt_1", sessionID: SES, messageID: "msg_2", type: "text", text: value })

describe("an answer that fails mid-stream", () => {
  test("keeps what was written, says the provider is retrying, then says why it stopped", () => {
    const [data, setData] = createStore(emptyChatData())
    const apply = (event: unknown) => applyChatEvent(event as ChatEvent, data, setData)
    apply({ type: "message.updated", properties: { info: user } })
    apply({ type: "session.status", properties: { sessionID: SES, status: { type: "busy" } } })
    apply({ type: "message.updated", properties: { info: assistant() } })
    apply({ type: "message.part.updated", properties: { part: text("Ecco la prima metà della ris") } })
    expect(retryNotice(data.session_status[SES])).toBeUndefined()

    // The provider breaks: nikcli retries, and the chat says so while it waits.
    apply({
      type: "session.status",
      properties: { sessionID: SES, status: { type: "retry", attempt: 2, message: "Provider Server Error", next: 9 } },
    })
    expect(retryNotice(data.session_status[SES])).toBe(t("chat.retry", 2))

    // It gives up: the message ends with the error, the text written so far stays.
    const error = { name: "APIError", data: { message: "Upstream error", statusCode: 502, isRetryable: true } }
    apply({ type: "message.updated", properties: { info: assistant({ time: { created: 2, completed: 3 }, error }) } })
    apply({ type: "session.status", properties: { sessionID: SES, status: { type: "idle" } } })
    const turn = conversationOf(data, SES).at(-1)!
    expect(turn.parts.map((part) => (part as { text?: string }).text)).toEqual(["Ecco la prima metà della ris"])
    expect(messageError(turn.info)).toEqual({ text: t("chat.error.providerDown"), detail: "Upstream error" })
    expect(retryNotice(data.session_status[SES])).toBeUndefined()
  })

  test("the recorded failure (a free model rate-limited upstream) reads as a limit, with the provider's sentence", () => {
    const events = readFileSync(new URL("./fixtures/errori.jsonl", import.meta.url), "utf8")
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as { type: string; properties: { error?: unknown } })
    const recorded = events.find((event) => event.type === "session.error")!.properties.error
    const view = answerError(recorded)!
    expect(view.text).toBe(t("chat.error.rateLimit"))
    expect(view.detail).toMatch(/temporarily rate-limited upstream/)
    // Only the provider's sentence: nothing else of the body.
    expect(view.detail).not.toMatch(/user_id|is_byok|provider_name/)
  })

  test("the chat's view draws the error of a turn and the retry line", () => {
    const view = readFileSync(new URL("./chat.tsx", import.meta.url), "utf8")
    expect(view).toMatch(/messageError\(props\.turn\.info\)/)
    expect(view).toMatch(/retryNotice\(/)
    expect(view).toMatch(/data-slot="chat-error-detail"/)
  })
})

describe("errors in words", () => {
  test("every kind nikcli sends has its sentence, in both languages", () => {
    const kinds = [
      [{ name: "MessageAbortedError", data: { message: "Aborted" } }, "chat.error.aborted"],
      [{ name: "MessageOutputLengthError", data: {} }, "chat.error.outputLength"],
      [{ name: "MessageContextOverflowError", data: { message: "too long" } }, "chat.error.contextOverflow"],
      [{ name: "ProviderAuthError", data: { providerID: "x", message: "bad key" } }, "chat.error.auth"],
      [{ name: "StructuredOutputError", data: { message: "no", retries: 2 } }, "chat.error.structured"],
      [{ name: "UnknownError", data: { message: "boom" } }, "chat.error.unknown"],
      [{ name: "APIError", data: { message: "m", statusCode: 401, isRetryable: false } }, "chat.error.auth"],
      [{ name: "APIError", data: { message: "m", statusCode: 402, isRetryable: false } }, "chat.error.credit"],
      [{ name: "APIError", data: { message: "m", statusCode: 404, isRetryable: false } }, "chat.error.modelMissing"],
      [{ name: "APIError", data: { message: "m", statusCode: 413, isRetryable: false } }, "chat.error.tooLarge"],
      [
        { name: "APIError", data: { message: "m", isRetryable: false, classification: "payload-too-large" } },
        "chat.error.tooLarge",
      ],
      [{ name: "APIError", data: { message: "m", statusCode: 503, isRetryable: true } }, "chat.error.providerDown"],
      [{ name: "APIError", data: { message: "m", isRetryable: false } }, "chat.error.api"],
    ] as const
    for (const language of ["it", "en"] as const) {
      setLocalePreference(language)
      for (const [error, key] of kinds) expect([error.name, answerError(error)!.text]).toEqual([error.name, t(key)])
    }
    expect(answerError({ name: "APIError", data: { message: "m", statusCode: 418, isRetryable: false } })!.text).toBe(
      t("chat.error.apiStatus", 418),
    )
    expect(answerError(undefined)).toBeUndefined()
  })

  test("the provider's words are clipped, and an abort has no detail", () => {
    const long = "x".repeat(1000)
    expect(answerError({ name: "UnknownError", data: { message: long } })!.detail!.length).toBe(300)
    expect(answerError({ name: "MessageAbortedError", data: { message: "Aborted" } })!.detail).toBeUndefined()
  })

  test("a failed request: the SDK's body, the bridge's string, a network error, the chat's own", () => {
    setLocalePreference("en")
    expect(requestProblem({ name: "NotFoundError", data: { message: "Session not found" } })).toBe(
      `${t("chat.error.unknown")} (Session not found)`,
    )
    expect(requestProblem({ data: { message: "Bad title" }, success: false })).toBe(
      `${t("chat.error.unknown")} (Bad title)`,
    )
    expect(requestProblem("connection refused")).toBe(`${t("chat.error.server")} (connection refused)`)
    expect(requestProblem(new TypeError("Failed to fetch"))).toBe(t("chat.error.server"))
    expect(requestProblem(new ForeignSession(t("chat.foreignSession")))).toBe(t("chat.foreignSession"))
    expect(requestProblem(new Error(t("chat.session.emptyTitle")))).toBe(t("chat.session.emptyTitle"))
    expect(requestProblem(undefined)).toBe(t("chat.error.unknown"))
    // Never an object's default string.
    expect(requestProblem({})).not.toMatch(/object Object/)
  })
})
