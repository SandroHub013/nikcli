import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { hookCommand, hookTarget, hookScript, installHook, missingActivityEvents } from "./agent-hooks"

/*
 * What the hook writes for each turn event, run for real with the PowerShell
 * Claude Code starts. A fake session id and a fake directory: nothing of the
 * user's is read or written.
 */
const run = test.skipIf(process.platform !== "win32")

function hookDir() {
  const dir = mkdtempSync(join(tmpdir(), "ade-hook-activity-"))
  const scriptPath = join(dir, "ade-agent-session.ps1")
  writeFileSync(scriptPath, hookScript("claude"), "utf8")
  const activity = join(dir, "nonce-act.activity")
  const fire = (payload: Record<string, unknown>) => {
    const result = Bun.spawnSync(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath], {
      stdin: new TextEncoder().encode(JSON.stringify({ session_id: "s-act", ...payload })),
      env: { ...process.env, ADE_SPAWN_NONCE: "nonce-act", ADE_PANE_ID: "pane-act", ADE_SESSION_DIR: dir },
      timeout: 20_000,
    })
    expect(result.exitCode).toBe(0)
  }
  const state = () => (existsSync(activity) ? JSON.parse(readFileSync(activity, "utf8")).state : undefined)
  const write = (value: string) =>
    writeFileSync(activity, JSON.stringify({ state: value, sessionId: "s-act", at: 1 }), "utf8")
  return { dir, fire, state, write, done: () => rmSync(dir, { recursive: true, force: true }) }
}

describe("the hook's turn file", () => {
  run(
    "a turn that ended on an API error ends the turn (fix 2)",
    () => {
      const hook = hookDir()
      try {
        hook.write("busy")
        hook.fire({ hook_event_name: "StopFailure", error: "rate_limit" })
        expect(hook.state()).toBe("idle")
      } finally {
        hook.done()
      }
    },
    60_000,
  )

  test("Claude Code is asked for StopFailure, and an install without it is found outdated (fix 2)", () => {
    const events = hookTarget("claude-code")?.activityEvents ?? []
    expect(events).toContain("StopFailure")
    const before = installHook(
      undefined,
      hookCommand("C:/u/.claude/hooks/ade-agent-session.ps1"),
      "startup|resume|clear",
      ["UserPromptSubmit", "Stop", "Notification"],
    )
    expect(missingActivityEvents(before, events)).toEqual(["StopFailure"])
  })

  run(
    "Claude Code waiting at its prompt ends a turn that had no Stop (fix 1)",
    () => {
      const hook = hookDir()
      try {
        // An Esc: the prompt's busy is still there, and nothing else will come.
        hook.write("busy")
        hook.fire({ hook_event_name: "Notification", notification_type: "idle_prompt" })
        expect(hook.state()).toBe("idle")
      } finally {
        hook.done()
      }
    },
    60_000,
  )

  run(
    "the waiting notice never takes a prompt away: an Enter would answer it",
    () => {
      const hook = hookDir()
      try {
        hook.write("permission")
        hook.fire({ hook_event_name: "Notification", notification_type: "idle_prompt" })
        expect(hook.state()).toBe("permission")
      } finally {
        hook.done()
      }
    },
    60_000,
  )
})
