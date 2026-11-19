import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { translate } from "../i18n"
import { codeOf } from "../test-support/source-text"

/*
 * Live test 12 (a new PC, no agent CLI). Chat, Bot and the new-session form said only «Serve Ragù Code» with a button, or
 * «1 sessione con nessun agente scelto in proj». The rule: when something is missing, the user is told why and what to do
 * next. A `.tsx` is not rendered here, so what matters in it is read from the source (as `room-panel.test.ts` does).
 */
const source = (...path: string[]) => codeOf(readFileSync(new URL(path.join("/"), import.meta.url), "utf8"))
const chat = source("chat.tsx")
const bots = source("..", "bots", "bots.tsx")
const room = source("..", "bots", "room-panel.tsx")
const newSession = source("..", "session-new", "session-new.tsx")

describe("without Ragù Code, Chat and Bot say why and what to do", () => {
  test("the sentence names Ragù Code and the official page, in both languages", () => {
    expect(translate("it", "chat.raguNeeded.hint")).toContain("Installalo dalla pagina ufficiale")
    expect(translate("it", "bots.raguNeeded.hint")).toContain("Installalo dalla pagina ufficiale")
    expect(translate("en", "chat.raguNeeded.hint")).toContain("official page")
    expect(translate("en", "bots.raguNeeded.hint")).toContain("official page")
    for (const key of ["chat.raguNeeded.hint", "bots.raguNeeded.hint"] as const) {
      expect(translate("it", key)).toContain("Ragù Code")
      expect(translate("en", key)).toContain("Ragù Code")
    }
  })

  test("lint: every pill that says «Serve Ragù Code» carries its sentence under it", () => {
    expect(chat).toContain('<smalldata-slot="chat-ragu-hint">{t("chat.raguNeeded.hint")}</small>')
    expect(room).toContain('<smalldata-slot="bots-ragu-hint">{t("bots.raguNeeded.hint")}</small>')
    // Bot's blank page and its composer.
    expect(bots.split('<smalldata-slot="bots-ragu-hint">{t("bots.raguNeeded.hint")}</small>').length - 1).toBe(2)
    // No pill without it: as many sentences as pills.
    const count = (file: string, part: string) => file.split(part).length - 1
    expect(count(chat, '{t("chat.raguNeeded")}')).toBe(count(chat, '{t("chat.raguNeeded.hint")}'))
    expect(count(bots, '{t("chat.raguNeeded")}')).toBe(count(bots, '{t("bots.raguNeeded.hint")}'))
    expect(count(room, '{t("chat.raguNeeded")}')).toBe(count(room, '{t("bots.raguNeeded.hint")}'))
  })

  test("the Bot sentence says ADE picks the install up on its own, and Bot does look again when the window is back", () => {
    // The claim in the text is true only while this stays: the PATH is read again on focus (the Chat reads it once).
    expect(bots).toContain('window.addEventListener("focus",onFocus)')
    expect(bots).toContain('invoke<boolean>("pty_refresh_path")')
    expect(bots).toContain("if(!hasRagu()){")
    expect(translate("en", "bots.raguNeeded.hint")).toContain("on its own")
    // The Chat does not, so its sentence says to reopen it and promises nothing else.
    expect(chat).not.toContain('addEventListener("focus"')
    expect(translate("en", "chat.raguNeeded.hint")).toContain("reopen Chat")
  })

  test("Chat shows neither the «sempre» note nor «Collega adesso» when there is no Ragù Code", () => {
    expect(chat).toContain("<Showwhen={hasRagu()}><RulesNote/></Show>")
    // The notice holds the «Collega adesso» button.
    expect(chat).toContain("<Showwhen={hasRagu()&&notice()}>")
  })
})

describe("the new-session line with no agent chosen", () => {
  test("is a sentence of its own, without a count of sessions or a «con»", () => {
    expect(translate("it", "new.summary.none", "proj")).toBe("Nessun agente scelto in proj")
    expect(translate("en", "new.summary.none", "proj")).toBe("No agent chosen in proj")
    // With an agent it stays as it was.
    expect(translate("it", "new.summary", 1, "Claude Code", "proj")).toBe("1 sessione con Claude Code in proj")
  })

  test("lint: the form uses it when no agent is chosen", () => {
    expect(newSession).toContain('agentId()?t("new.summary",count(),agentLabel(agentId()),props.workspace):t("new.summary.none",props.workspace)')
    expect(newSession).not.toContain("new.noAgentChosen")
  })
})
