/**
 * Where one worktree's ADE Test lives: its port, its WebView2 profile, its log.
 *
 * Several agent sessions work on ADE at once, each in its own worktree, and
 * each wants to try its change in a running app. They used to share
 * everything that made that safe: one dev port, one profile, one way to find
 * the process to stop. The port was the dangerous one. Vite is `strictPort`,
 * so a second worktree's Vite exited on 5177 — and Tauri then opened
 * `localhost:5177` anyway, where the *first* worktree's Vite answered. The
 * window said ADE Test and ran someone else's code.
 *
 * Everything here is derived from the worktree path, so it is the same on
 * every run and different between worktrees. Pure, so it can be tested; the
 * script in `scripts/test-app.ts` does the spawning.
 */

import { basename, join } from "node:path"

/** Dev ports are taken from 5200–5599, clear of Vite's 5173 and ADE's 5177. */
export const TEST_APP_PORT_BASE = 5200
export const TEST_APP_PORT_SPAN = 400
/** The remote-debugging port sits a fixed distance above the dev port. */
export const TEST_APP_CDP_OFFSET = 4000

export interface TestAppPlan {
  /** The worktree folder's name, which is what the badge shows. */
  name: string
  /** Name and branch, for the window title and the terminal. */
  label: string
  /** The preferred dev port; the script moves up when it is taken. */
  port: number
  stateDir: string
  profileDir: string
  tmpDir: string
  logPath: string
  recordPath: string
  configPath: string
}

/** What a started instance left behind, so `status` and `list` can describe it. */
export interface TestAppRecord {
  port: number
  cdpPort?: number
  label: string
  root: string
}

/** One row of the OS process table, as far as telling instances apart needs. */
export interface ProcessRow {
  pid: number
  ppid: number
  exe?: string
  cmd?: string
}

/**
 * The processes that make up one worktree's instance.
 *
 * Found by what only this worktree's processes can contain, not by a
 * recorded pid. A pid was the first design and it failed on the first run:
 * the liveness check behind it is a PowerShell call, one call failed under
 * the load of the Rust build, and the instance was declared gone while its
 * window was open. Paths do not have that failure, and they also survive the
 * parent being killed, which leaves `tauri`'s children orphaned but still
 * carrying the same arguments.
 *
 * The roots are the `tauri dev` processes (their `--config` names this
 * worktree's config), the WebView2 processes (their profile is this
 * worktree's), the app binary (built into this worktree's `target`) and this
 * port's Vite. Everything below a root belongs too: cargo, shells, esbuild.
 */
export function instanceProcesses(rows: readonly ProcessRow[], plan: TestAppPlan, root: string, port?: number): ProcessRow[] {
  const norm = (text: string | undefined) => (text ?? "").replace(/\\/g, "/").toLowerCase()
  const config = norm(plan.configPath)
  const profile = norm(plan.profileDir)
  const target = norm(join(root, "packages", "ade", "src-tauri", "target"))
  const tree = norm(root)

  const isRoot = (row: ProcessRow) => {
    const cmd = norm(row.cmd)
    const exe = norm(row.exe)
    if (cmd.includes(config) || cmd.includes(profile)) return true
    if (exe.startsWith(`${target}/`)) return true
    // `${tree}/`: `nikcli-ade` is a prefix of `nikcli-ade-testapp`.
    return port !== undefined && cmd.includes(`${tree}/`) && cmd.includes("vite") && cmd.includes(`--port ${port}`)
  }

  const members = new Set(rows.filter(isRoot).map((row) => row.pid))
  // Descendants, to a fixed point: a child can be listed before its parent.
  for (let grew = true; grew; ) {
    grew = false
    for (const row of rows) {
      if (!members.has(row.pid) && members.has(row.ppid)) {
        members.add(row.pid)
        grew = true
      }
    }
  }
  return rows.filter((row) => members.has(row.pid))
}

/** Whether the instance is still up: its `tauri dev` or its app binary. */
export function instanceRunning(members: readonly ProcessRow[], plan: TestAppPlan, root: string): boolean {
  const norm = (text: string | undefined) => (text ?? "").replace(/\\/g, "/").toLowerCase()
  const config = norm(plan.configPath)
  const target = norm(join(root, "packages", "ade", "src-tauri", "target"))
  return members.some((row) => norm(row.cmd).includes(config) || norm(row.exe).startsWith(`${target}/`))
}

/**
 * FNV-1a over the normalised path.
 *
 * Normalised because the same worktree is spelled `C:\Users\…` by Windows and
 * `C:/Users/…` by git, and a port that changed with the spelling would defeat
 * the point of deriving it.
 */
export function hashPath(path: string): number {
  const normalised = path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()
  let hash = 0x811c9dc5
  for (let i = 0; i < normalised.length; i++) {
    hash ^= normalised.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash
}

export function planTestApp(input: { root: string; branch: string }): TestAppPlan {
  const name = basename(input.root.replace(/[\\/]+$/, ""))
  const stateDir = join(input.root, ".ade-test")
  return {
    name,
    label: input.branch ? `${name} · ${input.branch}` : name,
    port: TEST_APP_PORT_BASE + (hashPath(input.root) % TEST_APP_PORT_SPAN),
    stateDir,
    profileDir: join(stateDir, "webview2"),
    tmpDir: join(stateDir, "tmp"),
    logPath: join(stateDir, "ade-test.log"),
    recordPath: join(stateDir, "record.json"),
    configPath: join(stateDir, "tauri.dev.json"),
  }
}

/**
 * The Tauri config fragment that points this instance at its own Vite.
 *
 * Both halves carry the port: the command that starts Vite and the URL the
 * window loads. `--strictPort` stays, so a port taken between the check and
 * the start fails the start instead of loading whatever holds it.
 */
export function devConfig(port: number): string {
  return JSON.stringify(
    {
      build: {
        beforeDevCommand: `bun x vite --port ${port} --strictPort`,
        devUrl: `http://localhost:${port}`,
      },
    },
    null,
    2,
  )
}

export function parseRecord(text: string): TestAppRecord | undefined {
  try {
    const value = JSON.parse(text) as Partial<TestAppRecord>
    if (typeof value.port !== "number" || typeof value.root !== "string") return undefined
    return value as TestAppRecord
  } catch {
    return undefined
  }
}

/**
 * Lines of `tauri dev` output that mean the start has failed.
 *
 * Checked as the log grows, because a failed start does not always end the
 * parent process: `tauri dev` keeps watching for changes after the app has
 * panicked, and waiting for it to exit would wait forever.
 */
export function startFailure(log: string): string | undefined {
  const patterns = [
    /Port \d+ is already in use/,
    /Failed to setup app[^\n]*/,
    /error\[E\d+\][^\n]*/,
    /error: could not compile[^\n]*/,
    /The "beforeDevCommand" terminated with a non-zero status code/,
    /process didn't exit successfully[^\n]*/,
  ]
  for (const pattern of patterns) {
    const match = log.match(pattern)
    if (match) return match[0]
  }
  return undefined
}
