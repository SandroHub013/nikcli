/**
 * Shared unwrapping for the `mobile.git` / `mobile.github` endpoints, which all
 * answer `{ data?, error? }` rather than throwing. Lifted out of the git toolbar
 * so the pull request and account dialogs can use it without importing the
 * toolbar back.
 */

export function errorMessage(value: unknown): string {
  if (value instanceof Error) return value.message
  if (typeof value === "string") return value
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>
    if (typeof record.message === "string") return record.message
    if (typeof record.error === "string") return record.error
    if (record.data) return errorMessage(record.data)
  }
  return "Unknown request error"
}

export async function requestData<T>(request: Promise<{ data?: T; error?: unknown }>): Promise<T> {
  const result = await request
  if (result.error) throw new Error(errorMessage(result.error))
  if (result.data === undefined) throw new Error("The server returned an empty response")
  return result.data
}
