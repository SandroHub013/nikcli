import { describe, expect, it } from "bun:test"
import { PermissionRuleset } from "@/permission/ruleset"

/*
 * N2 (review of the review of the bots): on Windows `Bun.write("<project>\.git.\hooks\pre-commit")` writes into
 * `.git\hooks\pre-commit`, but the rule sees `.git.\hooks\pre-commit` and a pattern for the `.git` folder never
 * matches it. For a bot's session the path is also read the way Windows reads it: the dots and spaces that end a
 * segment are dropped (a segment that is only dots stays), and the stricter of the two readings stands.
 */
const rule = (permission: string, pattern: string, action: PermissionRuleset.Rule["action"]): PermissionRuleset.Rule => ({
  permission,
  pattern,
  action,
})

const AGENT: PermissionRuleset.Ruleset = [rule("*", "*", "allow")]
const SESSION: PermissionRuleset.Ruleset = [
  rule("ade.bot", "*", "deny"),
  rule("edit", "*", "allow"),
  rule("edit", "*.git\\*", "deny"),
  rule("edit", "*.git/*", "deny"),
  rule("edit", "*.vscode\\*", "deny"),
  rule("edit", "*.github\\?????????\\*", "deny"),
]

const decide = (session: PermissionRuleset.Ruleset, permission: string, pattern: string) =>
  PermissionRuleset.evaluate(permission, pattern, PermissionRuleset.merge(AGENT, session)).action

describe("the path of a bot's write, read as Windows reads it", () => {
  it("drops the dots and spaces that end a segment, and nothing else", () => {
    expect(PermissionRuleset.windowsPathForm(".git.\\hooks\\pre-commit")).toBe(".git\\hooks\\pre-commit")
    expect(PermissionRuleset.windowsPathForm(".git. /hooks/x")).toBe(".git/hooks/x")
    expect(PermissionRuleset.windowsPathForm(".github.\\workflows.\\ci.yml")).toBe(".github\\workflows\\ci.yml")
    expect(PermissionRuleset.windowsPathForm("..\\a\\.\\b")).toBe("..\\a\\.\\b")
    expect(PermissionRuleset.windowsPathForm("src\\a.b.c")).toBe("src\\a.b.c")
    expect(PermissionRuleset.windowsPathForm("notes.")).toBe("notes")
  })

  it("denies a write into a folder spelled with a trailing dot or space", () => {
    expect(decide(SESSION, "edit", ".git\\hooks\\pre-commit")).toBe("deny")
    expect(decide(SESSION, "edit", ".git.\\hooks\\pre-commit")).toBe("deny")
    expect(decide(SESSION, "edit", ".git..\\hooks\\pre-commit")).toBe("deny")
    expect(decide(SESSION, "edit", ".git /hooks/pre-commit")).toBe("deny")
    expect(decide(SESSION, "edit", "sub\\.vscode.\\tasks.json")).toBe("deny")
    expect(decide(SESSION, "edit", ".github.\\workflows.\\ci.yml")).toBe("deny")
  })

  it("leaves an ordinary write alone", () => {
    expect(decide(SESSION, "edit", "src\\index.ts")).toBe("allow")
    expect(decide(SESSION, "edit", "docs.\\readme.md")).toBe("allow")
    expect(decide(SESSION, "edit", ".gitignore")).toBe("allow")
  })

  it("and a session that is not a bot's reads the path as it was written", () => {
    const session = SESSION.filter((entry) => entry.permission !== "ade.bot")
    expect(decide(session, "edit", ".git.\\hooks\\pre-commit")).toBe("allow")
  })
})
