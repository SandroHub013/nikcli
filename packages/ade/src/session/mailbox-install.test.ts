import { afterEach, describe, expect, test } from "bun:test"
import { resetLocaleForTests, t } from "../i18n"
import { mailboxInstallReason, parseMailboxInstallError } from "./mailbox-install"

/*
 * Fault 10: the native side no longer words the reason `ade-msg` could not be written (it used to hand over Italian
 * text that landed inside the English bell notice). It sends a code, `mailbox`, `bin` or `script:<name>: <system error>`,
 * and the page words it in the language of the app.
 */
afterEach(() => resetLocaleForTests())

describe("the reason ade-msg could not be written", () => {
  test("is read from the code the native side sends", () => {
    expect(parseMailboxInstallError("mailbox")).toEqual({ code: "mailbox" })
    expect(parseMailboxInstallError("bin")).toEqual({ code: "bin" })
    expect(parseMailboxInstallError("script:ade-msg.ps1: Access is denied. (os error 5)")).toEqual({
      code: "script",
      name: "ade-msg.ps1",
      detail: "Access is denied. (os error 5)",
    })
    // What it does not know is shown as it came, not dropped.
    expect(parseMailboxInstallError("something else")).toEqual({ code: "other", raw: "something else" })
  })

  test("is in English in an English app, with no Italian in the notice", () => {
    resetLocaleForTests("en", "en")
    for (const raw of ["mailbox", "bin", "script:ade-msg.cmd: Access is denied. (os error 5)"]) {
      const notice = t("mail.adeMsgFailed", mailboxInstallReason(raw))
      expect(notice.startsWith("Agents will not be able to use ade-msg: ")).toBe(true)
      expect(notice).not.toMatch(/cartella|non disponibile|scrittura|fallita|posta/i)
    }
    expect(mailboxInstallReason("mailbox")).toBe("the mailbox folder is not available")
    expect(mailboxInstallReason("bin")).toBe("the bin folder is not available")
    expect(mailboxInstallReason("script:ade-msg.cmd: Access is denied. (os error 5)")).toBe(
      "ade-msg.cmd could not be written (Access is denied. (os error 5))",
    )
  })

  test("is in Italian in an Italian app", () => {
    resetLocaleForTests("it", "it")
    expect(mailboxInstallReason("mailbox")).toBe("la cartella della posta non è disponibile")
    expect(mailboxInstallReason("bin")).toBe("la cartella bin non è disponibile")
    expect(mailboxInstallReason("script:ade-msg.cmd: Accesso negato. (os error 5)")).toBe(
      "ade-msg.cmd non si è potuto scrivere (Accesso negato. (os error 5))",
    )
    expect(mailboxInstallReason("something else")).toBe("something else")
  })
})
