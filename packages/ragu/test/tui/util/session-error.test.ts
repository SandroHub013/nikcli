import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { shouldToastSessionError, turnErrorText } from "@tui/util/session-error"

/*
 * Review of the UI, N7: the error of a failed turn was grey and did not say what to do («Incorrect API key
 * provided»), and the same error stayed in a red toast that covered the transcript while the next permission was
 * answered.
 */
const tui = (file: string) => readFileSync(join(import.meta.dir, "../../../../tui/src", file), "utf8")

describe("the error panel of a failed turn", () => {
  test("a missing or refused key says to run `ragu auth login <provider>`", () => {
    const text = turnErrorText({
      name: "ProviderAuthError",
      data: { providerID: "openai", message: "Incorrect API key provided" },
    })
    expect(text).toContain("Incorrect API key provided")
    expect(text).toContain("ragu auth login openai")
  })

  test("without a provider it still names the command", () => {
    expect(turnErrorText({ name: "ProviderAuthError", data: { message: "no key" } })).toContain("ragu auth login`")
  })

  test("other errors keep the friendly message they had", () => {
    expect(turnErrorText({ name: "APIError", data: { message: "overloaded" } })).toBe("overloaded")
  })

  test("it is drawn in the error colour, from the session's own component tokens", () => {
    const tokens = tui("context/component-tokens.ts")
    expect(tokens).toMatch(/"session\.error": \{[\s\S]*?text: "status\.error\.fg"/)
    const view = tui("routes/session/parts/assistant-message.tsx")
    expect(view).toContain("turnErrorText(error())")
    expect(view).not.toContain("friendlyErrorMessage(error())")
  })
})

describe("the toast for a session error", () => {
  test("the session on screen shows its error in the transcript: no toast", () => {
    expect(shouldToastSessionError({ error: { name: "APIError" }, sessionID: "ses_a", currentSessionID: "ses_a" })).toBe(
      false,
    )
  })

  test("another session's error still reaches the user", () => {
    expect(shouldToastSessionError({ error: { name: "APIError" }, sessionID: "ses_b", currentSessionID: "ses_a" })).toBe(
      true,
    )
    expect(shouldToastSessionError({ error: { name: "APIError" }, sessionID: "ses_b" })).toBe(true)
  })

  test("an interruption is not an error at all", () => {
    expect(shouldToastSessionError({ error: { name: "MessageAbortedError" }, sessionID: "ses_b" })).toBe(false)
  })

  test("the app asks it before it toasts", () => {
    const app = tui("app.tsx")
    expect(app).toContain("shouldToastSessionError(")
  })
})
