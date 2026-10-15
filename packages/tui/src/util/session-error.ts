import { friendlyErrorMessage } from "./error-message"

type SessionError = { name?: string; data?: { message?: unknown; providerID?: unknown } } | undefined

/**
 * The text of a failed turn's error panel: what happened, and for a missing or refused key, what to do about it.
 * (A grey «Incorrect API key provided» left the user to guess.)
 */
export function turnErrorText(error: unknown): string {
  const shaped = (error && typeof error === "object" ? error : undefined) as SessionError
  if (shaped?.name === "ProviderAuthError") {
    const message = typeof shaped.data?.message === "string" && shaped.data.message ? shaped.data.message : "Missing or refused credentials"
    const provider = typeof shaped.data?.providerID === "string" && shaped.data.providerID ? ` ${shaped.data.providerID}` : ""
    return `${message}\nRun \`ragu auth login${provider}\` to add a key, or check the provider's API key.`
  }
  return friendlyErrorMessage(error)
}

/**
 * Whether a `session.error` also goes to a toast. The session on screen already shows its error in the
 * transcript, so a toast would say the same thing twice, on top of the next permission prompt.
 */
export function shouldToastSessionError(input: {
  error: unknown
  sessionID?: string
  currentSessionID?: string
}): boolean {
  const error = input.error as SessionError
  if (error && typeof error === "object" && error.name === "MessageAbortedError") return false
  if (input.sessionID && input.sessionID === input.currentSessionID) return false
  return true
}
