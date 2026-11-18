import { t } from "../i18n"

/**
 * Why `ade-msg` could not be written at startup, as the native side reports it (`mailbox.rs`, `install`).
 *
 * It sends a code and not a sentence: `mailbox` or `bin` (a folder that could not be found), or
 * `script:<name>: <system error>`. The sentence is the page's, in the language of the app (Fault 10).
 */
export type MailboxInstallError =
  | { code: "mailbox" }
  | { code: "bin" }
  | { code: "script"; name: string; detail: string }
  | { code: "other"; raw: string }

export function parseMailboxInstallError(raw: string): MailboxInstallError {
  if (raw === "mailbox") return { code: "mailbox" }
  if (raw === "bin") return { code: "bin" }
  const script = /^script:([^:]+): (.*)$/s.exec(raw)
  if (script) return { code: "script", name: script[1]!, detail: script[2]! }
  return { code: "other", raw }
}

/** The reason, worded in the app's language; what is not a known code is shown as it came. */
export function mailboxInstallReason(raw: string): string {
  const error = parseMailboxInstallError(raw)
  if (error.code === "mailbox") return t("mail.installMailbox")
  if (error.code === "bin") return t("mail.installBin")
  if (error.code === "script") return t("mail.installScript", error.name, error.detail)
  return error.raw
}
