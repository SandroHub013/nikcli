import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { resetLocaleForTests, t } from "../i18n"
import { workbenchSource } from "../test-support/workbench-source"

const wbSource = workbenchSource()

describe("UX2-11: mail badge, waiting note and stuck message texts", () => {
  afterEach(() => resetLocaleForTests("it"))

  test("pane.mail informs user that mail arrives when session is free and invites click", () => {
    resetLocaleForTests("it")
    expect(t("pane.mail", 3)).toBe("3 in attesa: arrivano quando la sessione è libera. Clic per vederli.")
    expect(t("pane.mail", 3)).not.toContain("riga è a metà")

    resetLocaleForTests("en")
    expect(t("pane.mail", 3)).toBe("3 pending: will arrive when the session is free. Click to view.")
    expect(t("pane.mail", 3)).not.toContain("half-written")
    expect(t("pane.mail", 3)).not.toContain("half-typed")
  })

  test("note.mailWaiting does not assume session is typing", () => {
    resetLocaleForTests("it")
    expect(t("note.mailWaiting", "test")).toBe("Posta in attesa: test")
    expect(t("note.mailWaiting", "test")).not.toContain("la sessione sta scrivendo")

    resetLocaleForTests("en")
    expect(t("note.mailWaiting", "test")).toBe("Pending mail: test")
    expect(t("note.mailWaiting", "test")).not.toContain("the session is typing")
  })

  test("mail.stuck is plain non-technical message without raw kind or id", () => {
    resetLocaleForTests("it")
    expect(t("mail.stuck")).toBe(
      "Un messaggio tra sessioni non è stato consegnato e ADE ha smesso di aspettarlo. Chi l'ha mandato lo saprà, se è ancora aperto.",
    )

    resetLocaleForTests("en")
    expect(t("mail.stuck")).toBe(
      "A message between sessions was not delivered and ADE stopped waiting for it. The sender will know, if it is still open.",
    )
  })

  test("workbench showMail formats pending lines through t() without raw message id", () => {
    expect(wbSource).not.toContain("${entry.chars} caratteri, ${entry.id}")
    expect(wbSource).toContain('t("note.mailLine"')
  })
})
