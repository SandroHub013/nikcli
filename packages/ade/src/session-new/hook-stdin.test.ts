import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { HOOK_TARGETS, hookCommand, hookScript } from "./agent-hooks"

/*
 * The shell form, which a Claude Code older than the exec gate gets (audit
 * 0.7.7, C3): can a prompt get out of its string?
 *
 * Two halves. The command line is fixed — `hookCommand` names the program and
 * the script and nothing else, so what the user typed never reaches the shell
 * that tokenizes it. And the prompt arrives on stdin, where the script reads it
 * as JSON (`ConvertFrom-Json`) and never evaluates it: that half is run for
 * real below, with PowerShell, the way the shell starts it once it has split
 * that fixed line. What is not run here is Claude Code itself, nor the Git Bash
 * it puts in front on Windows: the shell only ever sees `hookCommand`.
 */
describe("a prompt on the hook's stdin stays data (C3)", () => {
  test("the command line carries nothing but the program and the script", () => {
    const script = "C:\\Users\\x\\.claude\\hooks\\ade-agent-session.ps1"
    expect(hookCommand(script)).toBe(`powershell -NoProfile -ExecutionPolicy Bypass -File "${script}"`)
  })

  test.skipIf(process.platform !== "win32")(
    "quotes, $, backticks, braces and ; in the prompt run nothing",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "ade-hook-stdin-"))
      try {
        const scriptPath = join(dir, "ade-agent-session.ps1")
        writeFileSync(scriptPath, hookScript("claude"), "utf8")
        const canary = (n: number) => join(dir, `pwned${n}`).replace(/\\/g, "/")
        const prompts = [
          `"; New-Item -ItemType File -Path '${canary(1)}'; "`,
          `$(New-Item -ItemType File -Path '${canary(2)}')`,
          "`" + `"; New-Item -ItemType File -Path '${canary(3)}' ; ` + "`",
          `"}; New-Item -ItemType File -Path '${canary(4)}'; {"`,
          `'); New-Item -ItemType File -Path '${canary(5)}'; ('`,
        ]
        for (const prompt of prompts) {
          const payload = JSON.stringify({ session_id: "s-c3", hook_event_name: "UserPromptSubmit", prompt })
          const run = Bun.spawnSync(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath], {
            stdin: new TextEncoder().encode(payload),
            env: { ...process.env, ADE_SPAWN_NONCE: "nonce-c3", ADE_PANE_ID: "pane-c3", ADE_SESSION_DIR: dir },
          })
          expect(run.exitCode).toBe(0)
        }
        for (let n = 1; n <= prompts.length; n++) expect(existsSync(canary(n))).toBe(false)
        // The script did read the JSON: it recorded the turn, so the payload reached it whole.
        const activity = readdirSync(dir).find((name) => name.endsWith(".activity"))
        expect(activity).toBeDefined()
        expect(readFileSync(join(dir, activity!), "utf8")).toContain("s-c3")
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
    30_000,
  )
})

/**
 * The `Notification` hook, run for real.
 *
 * A permission question used to be found by reading the glyphs on the screen,
 * which a CLI update can change, and a delivery's Enter would answer whichever
 * choice the prompt had selected. The hook is the CLI saying so, so what is
 * tested here is the script writing that state: PowerShell, the payload on
 * stdin, the file on disk — the whole way the news travels, not a string in the
 * source.
 */
describe("the Notification hook says a permission question is standing (P1)", () => {
  const run = (payload: Record<string, unknown>) => {
    const dir = mkdtempSync(join(tmpdir(), "ade-hook-notification-"))
    const scriptPath = join(dir, "ade-agent-session.ps1")
    writeFileSync(scriptPath, hookScript("claude"), "utf8")
    const run = Bun.spawnSync(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath], {
      stdin: new TextEncoder().encode(JSON.stringify({ session_id: "s-p1", cwd: "C:\\w", ...payload })),
      env: { ...process.env, ADE_SPAWN_NONCE: "nonce-p1", ADE_PANE_ID: "pane-p1", ADE_SESSION_DIR: dir },
    })
    const file = readdirSync(dir).find((name) => name.endsWith(".activity"))
    const activity = file ? JSON.parse(readFileSync(join(dir, file), "utf8")) : undefined
    rmSync(dir, { recursive: true, force: true })
    return { exit: run.exitCode, activity }
  }

  test.skipIf(process.platform !== "win32")("a permission prompt writes the permission state", () => {
    const { exit, activity } = run({ hook_event_name: "Notification", notification_type: "permission_prompt" })
    expect(exit).toBe(0)
    expect(activity?.state).toBe("permission")
    expect(activity?.sessionId).toBe("s-p1")
  })

  test.skipIf(process.platform !== "win32")("another notification is not a permission prompt", () => {
    // Claude Code sends Notification for the idle prompt too, and that one is not
    // something to hold messages for.
    const { exit, activity } = run({ hook_event_name: "Notification", notification_type: "idle_prompt" })
    expect(exit).toBe(0)
    // The turn is over. The Stop hook said so until an interruption, which sends
    // no Stop: now the idle prompt says it too (fix 1, hook-activity.test.ts).
    expect(activity?.state).toBe("idle")
  })

  test.skipIf(process.platform !== "win32")("the turn hooks still say busy and idle", () => {
    expect(run({ hook_event_name: "UserPromptSubmit" }).activity?.state).toBe("busy")
    expect(run({ hook_event_name: "Stop" }).activity?.state).toBe("idle")
  })
})

describe("Claude Code is asked for the Notification event", () => {
  test("it is in the activity events the settings install", () => {
    const claude = HOOK_TARGETS.find((target) => target.id === "claude-code")
    expect(claude?.activityEvents).toContain("Notification")
    // And the events it had before are still there: an install from before gets
    // the new one without losing the two old.
    expect(claude?.activityEvents).toEqual(["UserPromptSubmit", "Stop", "Notification", "StopFailure"])
  })
})
