import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { addPane, createWorkbench, fromWorkspaceState, toWorkspaceState } from "./state"

/*
 * Review of the frontend, ALTO 5: a bot's flags and a sign-in's subcommand
 * were handed only to the first start. A restart, or ADE reopening, ran the
 * bare agent: without `--agent`, on the default model, which can be paid.
 */

const source = readFileSync(join(import.meta.dir, "workbench.tsx"), "utf8")

function body(start: string): string {
  const at = source.indexOf(start)
  expect(at).toBeGreaterThan(-1)
  return source.slice(at, source.indexOf("\n  }\n", at))
}

describe("a bot and a sign-in start the same way after a restart (ALTO 5)", () => {
  test("lint: openBotSession keeps the bot's flags in spawnArgs, not in one start's extra (ALTO 5)", () => {
    const bot = body("const openBotSession = ")
    expect(bot).toContain("spawnArgs: [...launch.args]")
    // Not handed to this start alone.
    expect(bot).not.toMatch(/startProcess\([^)]*launch\.args/)
  })

  test("a bot's flags survive the save", () => {
    const wb = addPane(createWorkbench(), {
      id: "bot",
      title: "revisore",
      status: "idle",
      mode: "bot",
      workspaceId: "web",
      lines: [],
      model: "nikcli",
      agent: "nikcli",
      spawnArgs: ["--agent", "revisore", "--model", "openrouter/x:free"],
    })
    const back = fromWorkspaceState(JSON.parse(JSON.stringify(toWorkspaceState(wb))))
    expect(back.panes[0]?.spawnArgs).toEqual(["--agent", "revisore", "--model", "openrouter/x:free"])
  })

  test("a sign-in is not saved, so ADE opening does not start one", () => {
    let wb = addPane(createWorkbench(), {
      id: "a",
      title: "A",
      status: "idle",
      mode: "auto",
      lines: [],
      model: "codex",
      agent: "codex",
      workspaceId: "web",
    })
    wb = addPane(wb, {
      id: "login",
      title: "Claude Code · accesso",
      status: "idle",
      mode: "bot",
      workspaceId: "web",
      lines: [],
      model: "claude",
      agent: "claude-code",
      signIn: ["auth", "login"],
    })
    expect(toWorkspaceState(wb).panes.map((pane) => pane.id)).toEqual(["a"])
  })

  test("lint: a sign-in pane keeps signIn, and reopen runs it before planning a resume (ALTO 5)", () => {
    expect(body("const openLoginSession = ")).toContain("signIn: [...runner.login]")
    const reopen = body("const reopenPane = async ")
    expect(reopen).toContain(
      'if (restart.kind === "signIn") return startProcess(given.id, agentId, "", undefined, [...restart.extra])',
    )
    // Before anything that would plan a resume of a conversation it does not have.
    expect(reopen.indexOf("restartOf(given)")).toBeGreaterThan(-1)
    expect(reopen.indexOf("restartOf(given)")).toBeLessThan(reopen.indexOf("planResume"))
  })
})
