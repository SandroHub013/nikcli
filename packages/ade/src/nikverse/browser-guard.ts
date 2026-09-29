/**
 * Keeps the headless Edge/Chrome of the NikVerse scripts from outliving the script that started it.
 *
 * A browser is a tree of processes (GPU, renderers, crash handler, utilities) and none of them dies with a script that was
 * killed hard (a `spawnSync` timeout, a closed terminal, a crash). Worse: the process the script starts is not the
 * browser. On this machine `msedge.exe --headless=new` is a launcher that hands over to the real browser and exits at
 * once with code 0, so killing «the child and its tree» kills nothing, and the browser lives on (244 processes, 33 profiles
 * by the time someone counted). So the browser is found and killed by its profile, which every process of it carries in
 * its command line as `--user-data-dir=<profile>`, whoever their parent is. Four layers:
 *
 *  1. `stop()`: every process that names the profile, until none is left. The harness calls it in `close()` and on every
 *     error between the launch and the first page.
 *  2. Process hooks: `exit`, SIGINT/SIGTERM/SIGHUP/SIGBREAK, an uncaught exception or rejection stop every browser this
 *     process started, then leave.
 *  3. A watchdog (`scripts/nikverse-browser-watchdog.ts`, a process of its own) that watches the owner: when it dies
 *     without a word (nothing above runs on a hard kill) it kills the browser by its profile and removes it.
 *  4. `sweepOrphans()` at the start of every run: any browser whose profile says «nikverse-browser-<owner pid>» and whose
 *     owner is gone is killed, wherever the profile lives (the old ones were in %TEMP%).
 *
 * The profile lives under `.ade-test/browsers` of the package, inside Favorites (outside it the sandbox refuses writes),
 * and its name carries the owner's pid, which is how an orphan is told from a browser another script still uses.
 */

import { spawnSync } from "node:child_process"
import { mkdirSync, readdirSync, rmSync } from "node:fs"
import { join } from "node:path"

export const PROFILE_PREFIX = "nikverse-browser-"

/** Where the profiles are made: `<package>/.ade-test/browsers`, ignored by git. */
export const profilesDir = (packageRoot: string) => join(packageRoot, ".ade-test", "browsers")

/** The pid a browser's command line says owns it (from `--user-data-dir=...nikverse-browser-<pid>`), if it has one. */
export function ownerOf(commandLine: string): number | undefined {
  const match = /nikverse-browser-(\d+)(?![\w-])/.exec(commandLine)
  return match ? Number(match[1]) : undefined
}

/** Whether a command line names this profile (and not a longer one that begins the same: `...-123` is not `...-1234`). */
export function namesProfile(commandLine: string, profile: string): boolean {
  const line = commandLine.toLowerCase()
  const wanted = profile.toLowerCase()
  for (let at = line.indexOf(wanted); at >= 0; at = line.indexOf(wanted, at + 1))
    if (!/[\w-]/.test(line[at + wanted.length] ?? "")) return true
  return false
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: it exists and is not ours to signal, which is alive.
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

/** Kills processes and everything under them, in one call. Silent for those already gone. */
export function killTree(...pids: number[]): void {
  if (!pids.length) return
  if (process.platform === "win32")
    spawnSync("taskkill", ["/F", "/T", ...pids.flatMap((pid) => ["/PID", String(pid)])], {
      stdio: "ignore",
      windowsHide: true,
    })
  else
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGKILL")
      } catch {
        // Already gone.
      }
    }
}

export interface BrowserProcess {
  pid: number
  commandLine: string
}

/**
 * Every process of ours: those whose command line names a `nikverse-browser-*` profile (the main one and its children).
 * `program` is the executable's name pattern (the browsers'; a test's stand-in is a `bun`).
 */
export function browserProcesses(program = "msedge|chrome"): BrowserProcess[] {
  if (process.platform === "win32") {
    const listed = spawnSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${PROFILE_PREFIX}*' -and $_.Name -match '${program}' } | ForEach-Object { "$($_.ProcessId)|$($_.CommandLine)" }`,
      ],
      { encoding: "utf8", windowsHide: true },
    ).stdout
    return parse(listed ?? "")
  }
  // `ps` shows the program in the command line itself.
  const listed = spawnSync("ps", ["-eo", "pid=,args="], { encoding: "utf8" }).stdout
  return parse((listed ?? "").replace(/^\s*(\d+)\s+/gm, "$1|")).filter(
    (p) => p.commandLine.includes(PROFILE_PREFIX) && new RegExp(program).test(p.commandLine.split(" ")[0]),
  )
}

function parse(text: string): BrowserProcess[] {
  const found: BrowserProcess[] = []
  for (const line of text.split(/\r?\n/)) {
    const bar = line.indexOf("|")
    const pid = Number(line.slice(0, bar))
    if (bar > 0 && pid && pid !== process.pid) found.push({ pid, commandLine: line.slice(bar + 1) })
  }
  return found
}

/** Kills every process that names `profile`, again and again until none is left (a launcher can still be handing over). */
export function killByProfile(profile: string, program?: string, passes = 4): void {
  for (let pass = 0; pass < passes; pass++) {
    const mine = browserProcesses(program).filter((p) => namesProfile(p.commandLine, profile))
    if (!mine.length) return
    killTree(...mine.map((p) => p.pid))
  }
}

/**
 * Kills the browsers whose owner is gone, and removes their profiles when they are in `dirs`. `alive` and `list` are
 * the tests' to replace. Returns the pids it killed.
 */
export function sweepOrphans(
  dirs: string[] = [],
  alive: (pid: number) => boolean = isAlive,
  list: () => BrowserProcess[] = browserProcesses,
): number[] {
  const orphans = list().filter((proc) => {
    const owner = ownerOf(proc.commandLine)
    return owner !== undefined && owner !== process.pid && !alive(owner)
  })
  killTree(...orphans.map((p) => p.pid))
  for (const dir of dirs) {
    let names: string[] = []
    try {
      names = readdirSync(dir)
    } catch {
      continue
    }
    for (const name of names) {
      const owner = ownerOf(name)
      if (!name.startsWith(PROFILE_PREFIX) || owner === undefined || owner === process.pid || alive(owner)) continue
      try {
        rmSync(join(dir, name), { recursive: true, force: true })
      } catch {
        // A file still held by a process that is going away: the next sweep takes it.
      }
    }
  }
  return orphans.map((p) => p.pid)
}

const live = new Map<string, () => void>()
let hooked = false

function stopAll() {
  for (const stop of [...live.values()]) stop()
}

function hook() {
  if (hooked) return
  hooked = true
  process.on("exit", stopAll)
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"] as const)
    process.on(signal, () => {
      stopAll()
      process.exit(130)
    })
  for (const event of ["uncaughtException", "unhandledRejection"] as const)
    process.on(event, (error) => {
      console.error(`${event}:`, error)
      stopAll()
      process.exit(1)
    })
}

export interface Guard {
  /** Kills the browser (every process of its profile) and removes the profile. Safe to call twice. */
  stop(): void
}

export interface GuardOptions {
  /** The folder passed as `--user-data-dir`: the browser's identity. */
  profile: string
  /** The longest the browser may live, ms (the watchdog and this process both enforce it). Default 45 minutes. */
  maxMs?: number
  /** For tests: do not start the watchdog. */
  watchdog?: boolean
  /** For tests: the executable's name pattern of the browser (default the browsers'). */
  program?: string
}

/** Takes charge of a browser that has just been started: from here it cannot outlive this process. */
export function guardBrowser(options: GuardOptions): Guard {
  hook()
  const maxMs = options.maxMs ?? 45 * 60_000
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const stop = () => {
    if (stopped) return
    stopped = true
    if (timer) clearTimeout(timer)
    live.delete(options.profile)
    killByProfile(options.profile, options.program)
    try {
      rmSync(options.profile, { recursive: true, force: true })
    } catch {
      // The watchdog removes it once the last process lets go.
    }
  }
  live.set(options.profile, stop)
  timer = setTimeout(() => {
    console.error(`the browser outlived its ${Math.round(maxMs / 60_000)} minutes: stopped`)
    stop()
    process.exit(124)
  }, maxMs)
  if (options.watchdog !== false) {
    try {
      Bun.spawn(
        [
          process.execPath,
          join(import.meta.dir, "..", "..", "scripts", "nikverse-browser-watchdog.ts"),
          String(process.pid),
          options.profile,
          String(maxMs),
          options.program ?? "",
        ],
        { stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true },
      ).unref()
    } catch {
      // No watchdog: the hooks and the next sweep still hold.
    }
  }
  return { stop }
}

/** A profile folder of this process under `dir`, made. */
export function newProfile(dir: string): string {
  mkdirSync(dir, { recursive: true })
  const profile = join(dir, `${PROFILE_PREFIX}${process.pid}`)
  mkdirSync(profile, { recursive: true })
  return profile
}
