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

  it("cuts every segment at its first colon: `.git:$I30:$INDEX_ALLOCATION` is the folder `.git` (N2-bis)", () => {
    expect(PermissionRuleset.windowsPathForm(".git:$I30:$INDEX_ALLOCATION\\hooks\\pre-commit")).toBe(".git\\hooks\\pre-commit")
    expect(PermissionRuleset.windowsPathForm("a/.vscode:$I30:$INDEX_ALLOCATION/tasks.json")).toBe("a/.vscode/tasks.json")
    expect(PermissionRuleset.windowsPathForm(".github\\workflows:$I30:$INDEX_ALLOCATION\\ci.yml")).toBe(".github\\workflows\\ci.yml")
    expect(PermissionRuleset.windowsPathForm("ragu.json:stream")).toBe("ragu.json")
    expect(PermissionRuleset.windowsPathForm(".git.:$I30:$INDEX_ALLOCATION\\x")).toBe(".git\\x")
    // The drive of an absolute path keeps its colon.
    expect(PermissionRuleset.windowsPathForm("D:\\other\\.git:$I30:$INDEX_ALLOCATION\\x")).toBe("D:\\other\\.git\\x")
    expect(decide(SESSION, "edit", ".git:$I30:$INDEX_ALLOCATION\\hooks\\pre-commit")).toBe("deny")
    expect(decide(SESSION, "edit", ".vscode:$I30:$INDEX_ALLOCATION\\tasks.json")).toBe("deny")
    expect(decide(SESSION, "edit", ".github\\workflows:$I30:$INDEX_ALLOCATION\\ci.yml")).toBe("deny")
    expect(decide(SESSION, "edit", "src\\index.ts")).toBe("allow")
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
