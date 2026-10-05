import { describe, expect, it } from "bun:test"
import { execFile } from "node:child_process"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const MODULE = fileURLToPath(new URL("../../src/cli/exit-watchdog.ts", import.meta.url)).replace(/\\/g, "/")

/**
 * A finished `nikcli run` is supposed to fall off the end of the event loop. One run in 271 did not:
 * the model finished at 177s, the harness killed the process at 1,500s, and nothing in the log said
 * what held it. The watchdog is the safety net; these tests are the reason the net has a shape.
 *
 * They run in a real subprocess on purpose. The two properties that matter — "an `unref`'d watchdog
 * does not itself hold the process open" and "a live handle makes it fire" — are properties of the
 * *event loop*, and a test body is itself holding that loop open, so neither is observable in
 * process. In here, both assertions would have passed for the wrong reason.
 */

/**
 * Budgets, not thresholds about the watchdog: spawning bun costs 1.1-1.5s on this machine before
 * the harness script has run a line, so a wall-clock number has to leave room for the interpreter and
 * still fail loudly. What each test really asserts is printed next to it.
 */
const CLEAN_SHUTDOWN_MS = 6_000
const FORCED_EXIT_MS = 12_000

const scriptDir = mkdtempSync(path.join(tmpdir(), "nikcli-exit-watchdog-"))
const SCRIPT = path.join(scriptDir, "case.ts")

/** Arms the real watchdog, then leaves the loop in the state named by `CASE`. */
function harness(caseBody: string) {
  writeFileSync(
    SCRIPT,
    [
      `import { armExitWatchdog } from ${JSON.stringify(MODULE)}`,
      `armExitWatchdog({`,
      `  timeoutMs: 300,`,
      `  logger: (message, data) => console.log("WD:" + message + " " + JSON.stringify(data)),`,
      `})`,
      caseBody,
      `console.log("WORK_DONE")`,
    ].join("\n"),
    "utf8",
  )
}

type Outcome = { code: number; stdout: string; ms: number }

/**
 * Run the harness to completion.
 *
 * A non-zero exit is a *result*, not a failure here — forcing an exit with the code the command had
 * already chosen is the behaviour under test — so the code is captured rather than thrown.
 */
function attempt(caseBody: string, timeoutMs = 8000): Promise<Outcome> {
  harness(caseBody)
  const started = Date.now()
  return new Promise((resolve) => {
    execFile(process.execPath, [SCRIPT], { timeout: timeoutMs, windowsHide: true }, (error, stdout) => {
      resolve({
        code: (error as { code?: number } | null)?.code ?? 0,
        stdout,
        ms: Date.now() - started,
      })
    })
  })
}

describe("exit watchdog, in a real process", () => {
  it("lets a clean shutdown exit on its own, because the timer is unref'd", async () => {
    // No live handle. The process must fall off the end of the loop and exit well before the
    // watchdog's 300ms. If the timer were ref'd it would hold the process for the full budget — the
    // watchdog would have become the very bug it exists to catch.
    const { stdout, ms, code } = await attempt("")
    expect(stdout).toContain("WORK_DONE")
    // It finished on its own, so the watchdog never fired: no `WD:` line at all.
    expect(stdout).not.toContain("WD:")
    expect(code).toBe(0)
    expect(ms).toBeLessThan(CLEAN_SHUTDOWN_MS)
  })

  it("fires, explains itself, and exits when a handle outlives the work", async () => {
    // The shape of the benchmark run: the work is done, and a ref'd interval still holds the loop.
    // This is the `setInterval` the brief asks for, in the only place its effect is real.
    const { stdout, ms } = await attempt(`const live = setInterval(() => {}, 50)`)

    expect(stdout).toContain("WORK_DONE")
    const line = stdout.split("\n").find((l) => l.includes("WD:event loop did not drain")) ?? ""
    expect(line).not.toBe("")
    // The log carries the fact the benchmark lacked: the loop never drained.
    expect(line).toContain('"loopDrained":false')
    // It also lists the child processes still alive (here none, but the field must be there to read).
    expect(line).toContain('"children":[')
    // Bounded by the watchdog's own budget, not by the caller's patience.
    expect(ms).toBeLessThan(FORCED_EXIT_MS)
  })

  it("exits with the code the command already decided", async () => {
    // A forced exit must not quietly turn a failed run into a successful one, or the harness reads
    // the wrong result off the exit code.
    const { code, ms } = await attempt(`process.exitCode = 1\nconst live = setInterval(() => {}, 50)`)
    expect(code).toBe(1)
    expect(ms).toBeLessThan(6_000)
  })

  it("exits cleanly, and fast, when the live handle is released in time", async () => {
    // The watchdog must not fire just because work took a moment. Releasing the handle before the
    // budget expires is a clean shutdown, and has to look like one.
    const { stdout, ms, code } = await attempt(
      `const live = setInterval(() => {}, 50)\nsetTimeout(() => clearInterval(live), 50)`,
    )
    expect(stdout).toContain("WORK_DONE")
    expect(stdout).not.toContain("WD:")
    expect(code).toBe(0)
    expect(ms).toBeLessThan(2_000)
  })
})

describe("where `nikcli run` arms the watchdog", () => {
  // The bench runs `nikcli run` with no --attach. The watchdog used to be armed only on the attach
  // branch, so a local run that hung after `session.idle` (1 run in ~800) waited for the harness timeout.
  it("arms it in the local branch before the instance is disposed, as well as in the attach branch", async () => {
    const source = await Bun.file(new URL("../../src/cli/handlers/run.ts", import.meta.url)).text()
    const local = source.slice(source.indexOf('log.debug("Running local nikcli session")'))
    expect(local).toMatch(/await execute\(sdk, sessionID\)[\s\S]*?armExitWatchdog\(\)\s*\}\)/)
    expect(source.match(/armExitWatchdog\(\)/g)?.length).toBe(2)
  })
})
