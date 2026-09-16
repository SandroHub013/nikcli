/**
 * Name the failures in a settled batch.
 *
 * `Promise.all` is the wrong primitive for a set of independent best-effort
 * requests: it rejects on the first failure and discards which of the others
 * succeeded, so the caller can only record "something went wrong". Settling
 * keeps every outcome, and this turns the positional results back into the
 * names the caller started with.
 */
export type SettledFailures = {
  /** Names whose request rejected, in the order they were given. */
  readonly failed: string[]
  /** One message per failure, aligned with `failed`. */
  readonly errors: string[]
}

/**
 * HTTP status carried on a generated-client `ClientError`.
 *
 * The SDK throws `UnexpectedStatus` with `{ cause: { status } }` — that is how
 * the TUI learns a 499 (client abort) or 503 (server abort) from Effect's
 * HttpServer, which otherwise looks like any other failed fetch.
 */
export function clientErrorStatus(error: unknown): number | undefined {
  if (
    error instanceof Error &&
    typeof error.cause === "object" &&
    error.cause !== null &&
    "status" in error.cause &&
    typeof error.cause.status === "number"
  ) {
    return error.cause.status
  }
  return undefined
}

/**
 * Effect maps a pure interrupt on the request fiber to 499 (client abort) or
 * 503 (server abort). Both are transient: a retry, or a later bootstrap, can
 * succeed once the in-flight catalog build is no longer poisoned.
 */
export function isTransientHttpInterrupt(error: unknown): boolean {
  const status = clientErrorStatus(error)
  return status === 499 || status === 503
}

export async function retryTransient<T>(
  run: () => Promise<T>,
  options?: { retries?: number; delayMs?: number },
): Promise<T> {
  const retries = options?.retries ?? 2
  const delayMs = options?.delayMs ?? 250
  let last: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await run()
    } catch (error) {
      last = error
      if (!isTransientHttpInterrupt(error) || attempt === retries) throw error
      await new Promise((resolve) => setTimeout(resolve, delayMs * (attempt + 1)))
    }
  }
  throw last
}

export function namedFailures(names: readonly string[], results: readonly PromiseSettledResult<unknown>[]) {
  if (names.length !== results.length) {
    throw new RangeError(`namedFailures: ${names.length} names for ${results.length} results`)
  }
  const failed: string[] = []
  const errors: string[] = []
  for (let i = 0; i < results.length; i++) {
    const result = results[i]
    if (result.status !== "rejected") continue
    failed.push(names[i])
    errors.push(result.reason instanceof Error ? result.reason.message : String(result.reason))
  }
  return { failed, errors } satisfies SettledFailures
}
