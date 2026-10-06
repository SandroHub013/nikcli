import { MessageV2 } from "./message-v2"

export namespace SessionRetry {
  export const RETRY_INITIAL_DELAY = 2000
  export const RETRY_BACKOFF_FACTOR = 2
  export const RETRY_MAX_DELAY_NO_HEADERS = 30_000
  export const RETRY_MAX_DELAY = 2_147_483_647
  export const RETRY_MAX_ATTEMPTS = 5
  /**
   * Rate limits are waited out, not counted out: a free model's 15-requests-a-minute window reopens on
   * its own, so what ends the wait is a budget of waiting time (per request), not a number of tries.
   */
  export const RATE_LIMIT_MAX_DELAY = 60_000
  export const RATE_LIMIT_BUDGET_MS = 600_000
  /** How often a long rate-limit wait tells the rest of the process it is alive. */
  export const RATE_LIMIT_HEARTBEAT_MS = 30_000

  export async function sleep(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
      throw new DOMException("Aborted", "AbortError")
    }

    return new Promise((resolve, reject) => {
      let settled = false
      const abortHandler = () => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        signal.removeEventListener("abort", abortHandler)
        reject(new DOMException("Aborted", "AbortError"))
      }
      const timeout = setTimeout(
        () => {
          settled = true
          signal.removeEventListener("abort", abortHandler)
          resolve()
        },
        Math.min(ms, RETRY_MAX_DELAY),
      )
      signal.addEventListener("abort", abortHandler, { once: true })
    })
  }

  /**
   * A long wait in slices, calling `beat` before each one. Anything that decides a task is stuck
   * because nothing has happened for a while (the delegation watchdog) reads that as activity, so a
   * sub-agent that is only waiting for a rate-limit window is not expired for it.
   */
  export async function sleepWithHeartbeat(
    ms: number,
    signal: AbortSignal,
    beat: () => void | Promise<void>,
    every = RATE_LIMIT_HEARTBEAT_MS,
  ): Promise<void> {
    let left = Math.min(ms, RETRY_MAX_DELAY)
    while (true) {
      await beat()
      const slice = Math.min(left, every)
      await SessionRetry.sleep(slice, signal)
      left -= slice
      if (left <= 0) return
    }
  }

  /**
   * Whether an error is the provider saying "not now": a 429, or a message or body that says rate limit or
   * overloaded (the usual text of a 503; a bare 503 stays an ordinary retry). Out-of-credit errors are not: waiting does not bring credits back.
   */
  export function isRateLimit(error: object): boolean {
    // Both the plain `{name, data}` a stream error is mapped to and an APIError instance, whose fields sit on it.
    const data = ((error as { data?: Record<string, unknown> }).data ?? error) as Record<string, unknown>
    const body = typeof data["responseBody"] === "string" ? (data["responseBody"] as string) : ""
    const message = typeof data["message"] === "string" ? (data["message"] as string) : ""
    if (body.includes("FreeUsageLimitError") || message.includes("FreeUsageLimitError")) return false
    const status = typeof data["statusCode"] === "number" ? (data["statusCode"] as number) : undefined
    if (status === 429) return true
    return /rate.?limit|too many requests|free-models-per-min|overloaded|at capacity|resource.?exhausted/i.test(message + " " + body)
  }

  /**
   * How long a `x-ratelimit-reset*` header says to wait. The spellings differ by provider: a Unix
   * time in milliseconds (OpenRouter) or seconds, a number of seconds, or a duration such as
   * `1s`, `6m0s` or `250ms` (OpenAI).
   */
  export function resetDelay(headers: Record<string, string>, now = Date.now()): number | undefined {
    for (const key of ["x-ratelimit-reset", "x-ratelimit-reset-requests", "x-ratelimit-reset-tokens"]) {
      const raw = headers[key]
      if (!raw) continue
      const value = raw.trim()
      let ms: number | undefined
      if (/^\d+(\.\d+)?$/.test(value)) {
        const n = Number.parseFloat(value)
        ms = n > 1e12 ? n - now : n > 1e9 ? n * 1000 - now : n * 1000
      } else {
        const match = value.match(/^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m(?!s))?(?:(\d+(?:\.\d+)?)s)?(?:(\d+(?:\.\d+)?)ms)?$/)
        if (match && match[0] !== "") {
          ms =
            (Number.parseFloat(match[1] ?? "0") * 3600 +
              Number.parseFloat(match[2] ?? "0") * 60 +
              Number.parseFloat(match[3] ?? "0")) *
              1000 +
            Number.parseFloat(match[4] ?? "0")
        }
      }
      if (ms !== undefined && Number.isFinite(ms) && ms > 0) return Math.ceil(ms)
    }
    return undefined
  }

  export function delay(attempt: number, error?: MessageV2.APIError, options?: { rateLimited?: boolean }) {
    // Rate limits wait longer between tries and spread them more: a free model's window is a minute.
    const cap = options?.rateLimited ? RATE_LIMIT_MAX_DELAY : RETRY_MAX_DELAY_NO_HEADERS
    const jitterShare = options?.rateLimited ? 0.25 : 0.1
    // Calculate base delay with exponential backoff
    const baseDelay = RETRY_INITIAL_DELAY * Math.pow(RETRY_BACKOFF_FACTOR, attempt - 1)

    if (error) {
      const headers = error.responseHeaders
      if (headers) {
        const retryAfterMs = headers["retry-after-ms"]
        if (retryAfterMs) {
          const parsedMs = Number.parseFloat(retryAfterMs)
          if (!Number.isNaN(parsedMs)) {
            return parsedMs
          }
        }

        const retryAfter = headers["retry-after"]
        if (retryAfter) {
          const parsedSeconds = Number.parseFloat(retryAfter)
          if (!Number.isNaN(parsedSeconds)) {
            return Math.ceil(parsedSeconds * 1000)
          }
          const parsed = Date.parse(retryAfter) - Date.now()
          if (!Number.isNaN(parsed) && parsed > 0) {
            return Math.ceil(parsed)
          }
        }

        const reset = resetDelay(headers)
        if (reset !== undefined) return reset

        // Add 10% jitter to prevent thundering herd
        const jitter = baseDelay * Math.random() * jitterShare
        return Math.min(baseDelay + jitter, cap)
      }
    }

    // Add 10% jitter to prevent thundering herd
    const jitter = baseDelay * Math.random() * jitterShare
    return Math.min(baseDelay + jitter, cap)
  }

  function mapPlainRetryMessage(message: string): string | undefined {
    const lower = message.toLowerCase()
    // NVIDIA NIM / worker saturation (often plain text, not JSON)
    if (
      message.includes("Worker local total request limit") ||
      lower.includes("resourceexhausted") ||
      lower.includes("resource exhausted")
    ) {
      return "Provider is overloaded"
    }
    // OpenAI-compatible stream overload events
    if (
      lower.includes("server_is_overloaded") ||
      lower.includes("service_unavailable_error") ||
      lower.includes("service unavailable")
    ) {
      return "Provider is overloaded"
    }
    if (message.includes("Overloaded") || lower.includes("overloaded")) {
      return "Provider is overloaded"
    }
    return undefined
  }

  function mapJsonRetryMessage(message: string): string | undefined {
    try {
      const json = JSON.parse(message)
      if (json.type === "error" && json.error?.type === "too_many_requests") {
        return "Too Many Requests"
      }
      if (typeof json.code === "string" && (json.code.includes("exhausted") || json.code.includes("unavailable"))) {
        return "Provider is overloaded"
      }
      // OpenRouter reports an upstream failure inside a stream that already
      // answered 200, as {code: 502, message, metadata: {error_type}}, so the
      // HTTP status never says 5xx. A numeric code used to reach the string
      // check above and throw, which made the error look fatal.
      if ((typeof json.code === "number" && json.code >= 500) || json.metadata?.error_type === "provider_unavailable") {
        return "Provider Server Error"
      }
      if (json.type === "error" && json.error?.code?.includes("rate_limit")) {
        return "Rate Limited"
      }
      const errType = typeof json.error?.type === "string" ? json.error.type : undefined
      if (
        errType === "server_is_overloaded" ||
        errType === "service_unavailable_error" ||
        errType === "overloaded_error"
      ) {
        return "Provider is overloaded"
      }
      if (
        json.error?.message?.includes("no_kv_space") ||
        (json.type === "error" && json.error?.type === "server_error") ||
        !!json.error
      ) {
        return "Provider Server Error"
      }
    } catch {
      // Not JSON
    }
    return undefined
  }

  export function retryable(error: { name: string; data?: Record<string, unknown> }) {
    if (MessageV2.APIError.isInstance(error)) {
      const status = error.data.statusCode
      // 5xx errors are transient server failures - always retry them even if not marked retryable
      if (!error.data.isRetryable && !(status !== undefined && status >= 500)) return undefined
      if (
        error.data.responseBody?.includes("FreeUsageLimitError") ||
        error.data.message.includes("FreeUsageLimitError")
      ) {
        return `Free usage exceeded, add credits https://nikcli-ai.dev/zen`
      }
      const body = error.data.responseBody
      if (typeof body === "string") {
        const fromBody = mapPlainRetryMessage(body) ?? mapJsonRetryMessage(body)
        if (fromBody) return fromBody
      }
      return mapPlainRetryMessage(error.data.message) ?? mapJsonRetryMessage(error.data.message) ?? error.data.message
    }

    if (typeof error.data?.message === "string") {
      return mapPlainRetryMessage(error.data.message) ?? mapJsonRetryMessage(error.data.message)
    }

    return undefined
  }
}
