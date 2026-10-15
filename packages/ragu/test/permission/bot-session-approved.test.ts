import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { PermissionRuleset } from "@/permission/ruleset"

/*
 * S4 (review of the bots): a «sempre» given once for the project — in the TUI too — comes after every rule and won
 * over the session's: it opened the configuration to a bot, and `rm *` let `rm -rf ~` through. A bot's session of
 * ADE carries a mark (`ade.bot`), and for it the grants of the project do not count.
 */
const rule = (permission: string, pattern: string, action: PermissionRuleset.Rule["action"]): PermissionRuleset.Rule => ({
  permission,
  pattern,
  action,
})

// What ragu's default agent says, then a bot's session: the mark, a block list, the configuration closed.
const AGENT: PermissionRuleset.Ruleset = [rule("*", "*", "allow")]
const BOT_SESSION: PermissionRuleset.Ruleset = [
  rule("ade.bot", "*", "deny"),
  rule("edit", "*nikcli.json", "deny"),
  rule("bash", "*", "ask"),
  rule("bash", "rm * ~", "deny"),
  rule("bash", "rm -rf", "deny"),
]
const APPROVED: PermissionRuleset.Ruleset = [
  rule("bash", "rm *", "allow"),
  rule("edit", "*", "allow"),
  rule("bash", "git push *", "allow"),
]

const decide = (ruleset: PermissionRuleset.Ruleset, permission: string, pattern: string) =>
  PermissionRuleset.evaluate(permission, pattern, ruleset, PermissionRuleset.approvedFor(ruleset, APPROVED)).action

describe("a «sempre» of the project and a bot's session", () => {
  it("knows a bot's session by its mark, and only by that", () => {
    expect(PermissionRuleset.isBotSession([...AGENT, ...BOT_SESSION])).toBe(true)
    expect(PermissionRuleset.isBotSession(AGENT)).toBe(false)
    expect(PermissionRuleset.isBotSession([rule("ade.bot", "*", "allow")])).toBe(false)
    expect(PermissionRuleset.isBotSession([rule("ade.bot", "src/*", "deny")])).toBe(false)
  })

  it("does not let a grant of the project open what the bot's session closed", () => {
    const ruleset = [...AGENT, ...BOT_SESSION]
    // `rm *` approved for the project: not for a bot.
    expect(decide(ruleset, "bash", "rm -rf ~")).toBe("deny")
    expect(decide(ruleset, "bash", "rm build")).toBe("ask")
    expect(decide(ruleset, "edit", "nikcli.json")).toBe("deny")
    // The bot's session asks about its own commands, whatever was approved for the project.
    expect(decide(ruleset, "bash", "git push origin main")).toBe("ask")
  })

  it("leaves every other session as it was: the grant counts, last", () => {
    const ruleset = [...AGENT, rule("bash", "*", "ask"), rule("bash", "rm * ~", "deny")]
    expect(decide(ruleset, "bash", "rm -rf ~")).toBe("allow")
    expect(decide(ruleset, "bash", "git push origin main")).toBe("allow")
  })

  it("and the same grants, without the mark, are what they were before", () => {
    const withMark = [...AGENT, ...BOT_SESSION]
    const without = withMark.filter((entry) => entry.permission !== "ade.bot")
    expect(PermissionRuleset.approvedFor(without, APPROVED)).toBe(APPROVED)
    expect(PermissionRuleset.approvedFor(withMark, APPROVED)).toEqual([])
  })

  it("ask() takes the grants through it", () => {
    const source = readFileSync(join(import.meta.dir, "../../src/permission/next.ts"), "utf8")
    expect(source).toContain("PermissionRuleset.approvedFor(ruleset, s.approved)")
    expect(source).not.toMatch(/evaluate\(request\.permission, pattern, ruleset, s\.approved\)/)
  })
})
