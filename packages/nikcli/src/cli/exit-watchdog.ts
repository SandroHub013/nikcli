import { Log } from "@nikcli-ai/util/log"

const log = Log.create({ service: "exit-watchdog" })

/**
 * How long a finished `nikcli run` may linger before we take the exit away from it.
 *
 * Ten seconds is long enough that a machine under load is not punished for a slow
 * teardown (the dispose of the instance stops language servers, monitors and plugins), and short enough that a wedged run costs a harness timeout instead of
 * the full 1,500s the benchmark allows.
 */
const DEFAULT_TIMEOUT_MS = 10_000

export type WatchdogHandle = { cancel(): void }

/**
 * After the work is done, the process is supposed to fall off the end of the event
 * loop and exit. It does not have to: anything holding a reference — a timer that was
 * never `unref`'d, a socket, a child process — keeps the loop alive forever, and
 * `nikcli run` hangs with its answer already printed.
 *
 * The benchmark lost one run in 271 to exactly this: the model finished at 177s and
 * the process was still alive at 1,500s. What we could not tell afterwards was *what*
 * held it, because by the time the harness gave up the process was killed.
 *
 * So: arm a timer that does not itself keep the process alive, and if the loop has
 * still not drained by the time it fires, say so and exit with the code the command
 * already decided. Losing the chance to print a trailing log line is strictly better
 * than losing the run.
 *
 * `unref()` is the whole mechanism. With it, a clean shutdown never sees this code
 * run at all: the timer simply dies with the process. It only fires when something
 * *else* is holding the loop open, which is exactly the case worth acting on.
 */
export function armExitWatchdog(
  options: {
    timeoutMs?: number
    /**
     * Seam for the test; defaults to the real `process.exit`.
     *
     * Returns `void` rather than `never` on purpose: the production value never returns, but a test
     * double has to, and typing it `never` would make every stand-in in every test a lie about its
     * control flow.
     */
    exit?: (code: number) => void
    logger?: (message: string, data: Record<string, unknown>) => void
    /** Seam for the test; defaults to `Date.now`. */
    now?: () => number
    /** Seam for the test; defaults to the live child processes of this process. */
    children?: () => string[]
  } = {},
): WatchdogHandle {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const exit = options.exit ?? ((code: number) => process.exit(code))
  const logger = options.logger ?? ((message, data) => log.warn(message, data))
  const now = options.now ?? (() => Date.now())
  const children = options.children ?? childProcesses
  const armedAt = now()

  // Whether the event loop ever drained. `beforeExit` fires when the loop empties, and
  // it is the same signal the benchmark's own logs turned on: a run that reaches
  // `cleanup: stopping all workspace sync loops` exited normally, the hung one did not.
  // So if the watchdog fires, this stays false, and that is worth recording.
  let loopDrained = false
  const onBeforeExit = () => {
    loopDrained = true
  }
  process.once("beforeExit", onBeforeExit)

  const timer = setTimeout(() => {
    process.off("beforeExit", onBeforeExit)
    logger("event loop did not drain; forcing exit", {
      timeoutMs,
      aliveForMs: now() - armedAt,
      loopDrained,
      resources: activeResources(),
      children: children(),
      hint: "a handle kept the loop alive after the work finished; the fields above are what this runtime can report",
    })
    // The command already decided its fate: `run` exits 1 explicitly on the error paths and
    // otherwise lets the process exit 0. Repeating that decision here keeps a forced exit
    // indistinguishable from a clean one, which is what lets the harness trust the code.
    exit(typeof process.exitCode === "number" ? process.exitCode : 0)
  }, timeoutMs)
  // Never let the watchdog be the reason the process stays alive.
  timer.unref?.()

  return {
    cancel() {
      clearTimeout(timer)
      process.off("beforeExit", onBeforeExit)
    },
  }
}

/**
 * Whatever the runtime is willing to tell us about live handles.
 *
 * On Node this is `getActiveResourcesInfo()`. On Bun it is present but always `[]` —
 * measured, with a live `Bun.serve` and a live `net.Server` — and `process
 * ._getActiveHandles` is not implemented either. So an empty list here means "this
 * runtime cannot answer", *not* "nothing is alive", and reporting it without that
 * caveat would send the next person looking in the wrong place.
 */
function activeResources(): { runtime: string; resources: string[]; usable: boolean } {
  const runtime =
    typeof Bun === "undefined" ? "node" : `bun ${typeof Bun.version === "string" ? Bun.version : ""}`.trim()
  try {
    const info = process.getActiveResourcesInfo?.()
    if (!Array.isArray(info)) return { runtime, resources: [], usable: false }
    // An empty answer from a Bun build that does implement the call is indistinguishable
    // from one that stubs it, so treat "no handles listed" as unusable and say so.
    return { runtime, resources: info, usable: info.length > 0 }
  } catch {
    return { runtime, resources: [], usable: false }
  }
}

/**
 * The child processes still alive under this one (language servers, monitors, a formatter, herdr):
 * the one thing about "what holds the loop open" that can be read from outside the runtime. Costs a
 * second at most and only runs when the watchdog has already fired.
 */
function childProcesses(): string[] {
  try {
    const win = process.platform === "win32"
    const result = Bun.spawnSync(
      win
        ? [
            "powershell",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `Get-CimInstance Win32_Process -Filter "ParentProcessId=${process.pid}" | ForEach-Object { "$($_.ProcessId) $($_.Name) $($_.CommandLine)" }`,
          ]
        : ["ps", "-o", "pid=,comm=,args=", "--ppid", String(process.pid)],
      { stdout: "pipe", stderr: "ignore", timeout: 3000 },
    )
    return result.stdout
      .toString()
      .split(/\r?\n/)
      .map((line) => line.trim().slice(0, 200))
      .filter((line) => line && !line.includes("Get-CimInstance"))
      .slice(0, 20)
  } catch {
    return []
  }
}
