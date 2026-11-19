import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { REREAD_GAP_MS, raguFound } from "../host/ragu-check"
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

  test("a Ragù Code found only after the PATH is reread opens Chat and Bot", async () => {
    // The installer wrote the new directory to the user's environment, not to ADE's PATH: the first look finds nothing.
    let reread = false
    const probes: string[] = []
    const host = {
      probe: async (command: string) => {
        probes.push(command)
        return reread ? "ragu 1.0" : null
      },
      refreshPath: async () => {
        reread = true
        return true
      },
    }
    expect(await raguFound(host)).toBe(true)
    expect(probes).toEqual(["ragu", "ragu"])
    // Present at once: one look, and no PATH read for everyone who has it.
    let asked = false
    expect(
      await raguFound({
        probe: async () => "ragu 1.0",
        refreshPath: async () => ((asked = true), true),
      }),
    ).toBe(true)
    expect(asked).toBe(false)
    // Still missing after the reread: the pill stays. A host that cannot reread, or fails, is looked up as it is.
    expect(await raguFound({ probe: async () => null, refreshPath: async () => true })).toBe(false)
    expect(await raguFound({ probe: async () => null })).toBe(false)
    expect(await raguFound({ probe: async () => null, refreshPath: () => Promise.reject(new Error("no")) })).toBe(false)
    // No host (the browser harness): no answer, and the caller keeps what it assumed.
    expect(await raguFound(undefined)).toBeUndefined()
  })

  test("the PATH is reread once at a time and not again inside the gap, while every caller still gets its answer", async () => {
    // macOS and Linux: a reread is a login shell of up to 8 s, and Chat and Bot ask for it at every opening and focus.
    let clock = 1_000_000
    let rereads = 0
    let installed = false
    let finish: () => void = () => {}
    const host = {
      probe: async () => (installed ? "ragu 1.0" : null),
      refreshPath: () =>
        new Promise<boolean>((resolve) => {
          rereads += 1
          finish = () => {
            installed = true
            resolve(true)
          }
        }),
    }
    // Four callers while the first reread runs: one reread, and all four wait for it.
    const together = [1, 2, 3, 4].map(() => raguFound(host, () => clock))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(rereads).toBe(1)
    finish()
    expect(await Promise.all(together)).toEqual([true, true, true, true])
    expect(rereads).toBe(1)

    // Still missing, asked again inside the gap: no second reread, only the look; and past it, one more.
    installed = false
    clock += REREAD_GAP_MS - 1
    expect(await raguFound(host, () => clock)).toBe(false)
    expect(rereads).toBe(1)
    clock += 1
    const later = raguFound(host, () => clock)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(rereads).toBe(2)
    finish()
    expect(await later).toBe(true)
  })

  test("lint: Chat and Bot ask the one check, at the opening and, in Bot, whenever the window comes back", () => {
    expect(chat).toContain("raguFound(awaitgetHost())")
    expect(bots).toContain("raguFound(awaitgetHost())")
    expect(bots).toContain('window.addEventListener("focus",onFocus)')
    expect(bots).toContain("if(!hasRagu())voidprobeRagu()")
    // Neither keeps a lookup of its own: that one reads the PATH ADE started with.
    expect(chat).not.toContain('"pty_which"')
    expect(bots).not.toContain('"pty_which"')
  })

  test("the sentences promise what the code does: reopen Chat, come back to the window or reopen Bot", () => {
    expect(translate("en", "chat.raguNeeded.hint")).toContain("reopen Chat")
    expect(translate("en", "bots.raguNeeded.hint")).toContain("come back to this window or reopen Bot")
    expect(translate("it", "bots.raguNeeded.hint")).toContain("torni a questa finestra o riapri Bot")
  })

  test("Ragù Code is described as what ADE uses, not as «l'agente di questo progetto» (progetto is the user's folder)", () => {
    for (const language of ["it", "en"] as const) {
      for (const key of ["chat.raguNeeded.hint", "bots.raguNeeded.hint"] as const) {
        expect(translate(language, key)).not.toMatch(/progetto|project/)
      }
    }
    expect(translate("it", "chat.raguNeeded.hint")).toContain("l'agente che ADE usa per la Chat")
    expect(translate("it", "bots.raguNeeded.hint")).toContain("l'agente che ADE usa per i bot")
  })

  test("lint: Chat keeps «Apri un progetto» without Ragù Code and hides only the not-connected notice with its button", () => {
    expect(chat).toContain("<Showwhen={hasRagu()}><RulesNote/></Show>")
    expect(chat).toContain('returnnow?.kind==="notOpen"&&!hasRagu()?undefined:now')
    expect(chat).toContain("<Showwhen={shownNotice()}>")
    // The notice holds the «Collega adesso» button; the whole notice is not gated any more.
    expect(chat).not.toContain("hasRagu()&&notice()")
  })
})

describe("the new-session line with no agent chosen", () => {
  test("is a sentence of its own, without a count of sessions or a «con»", () => {
    expect(translate("it", "new.summary.none", "proj")).toBe("Nessun agente scelto in proj")
    expect(translate("en", "new.summary.none", "proj")).toBe("No agent chosen in proj")
    // With an agent it stays as it was.
    expect(translate("it", "new.summary", 1, "Claude Code", "proj")).toBe("1 sessione con Claude Code in proj")
  })

  test("lint: the form uses it when no agent is chosen, and not while the agents are still being looked up", () => {
    expect(newSession).toContain('<Showwhen={agents()!==undefined}><spandata-slot="new-summary">')
    expect(newSession).toContain('agentId()?t("new.summary",count(),agentLabel(agentId()),props.workspace):t("new.summary.none",props.workspace)')
    expect(newSession).not.toContain("new.noAgentChosen")
  })
})
