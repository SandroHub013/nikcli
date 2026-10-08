import { Database } from "bun:sqlite"
import fs from "fs"
import os from "os"
import path from "path"

/**
 * `ragu migrate`: renames a user's nikcli folders (data, cache, config, state) to ragu, once. Until it runs,
 * rule B (`@ragu/util/app-folder`) reads the nikcli ones; nothing else ever moves them.
 *
 * - A dry run by default: it says what it would move and changes nothing. `--apply` moves.
 * - Before moving: nothing may have them open. A service whose registered pid is alive, or (macOS, Linux) a
 *   process holding nikcli.db, stops it; on Windows a folder with an open file cannot be renamed, and the
 *   rename itself is the lock check. Then nikcli.db's WAL is checkpointed into the database (a read open in
 *   another connection makes that fail, and stops it), and auth.json and the small configs are copied to a
 *   backup folder beside the data folder.
 * - Each folder is renamed inside its own parent, so on the same volume: a rename, never a copy (the data
 *   folder is gigabytes). A rename that fails (a file locked) undoes the ones before it, so nothing is left
 *   half moved, and says which folder and why.
 * - A folder that has both names is left alone and reported: which one is right is the user's call.
 * - `~/.nikcli` stays: its `bin/` is the installed CLI on the PATH; the installer's brief moves it.
 *
 * Undo: `ragu migrate --rollback` (a dry run) and `ragu migrate --rollback --apply` rename back every folder
 * migrate moved, found by the mark it leaves in each (`MARK`); a ragu folder without it is not touched.
 */
export namespace Migrate {
  export type Kind = "data" | "cache" | "config" | "state"
  export const KINDS: readonly Kind[] = ["data", "cache", "config", "state"]

  /** The parent of each folder: where `nikcli` and `ragu` sit side by side. */
  export type Roots = Record<Kind, string>

  export type Status = "move" | "done" | "both" | "none" | "unmarked"
  export interface Step {
    readonly kind: Kind
    readonly from: string
    readonly to: string
    readonly status: Status
  }

  export interface Report {
    readonly steps: Step[]
    readonly applied: boolean
    readonly blocked?: { readonly reason: string; readonly pids?: number[]; readonly path?: string }
    readonly backup?: string
  }

  export interface Deps {
    /** Processes other than this one holding one of `files` open. */
    livePids(files: string[]): Promise<number[]>
    rename(from: string, to: string): Promise<void>
    isAlive(pid: number): boolean
    now(): Date
  }

  /** The mark migrate leaves in each folder it moved, so `--rollback` moves back only those. */
  export const MARK = "migrated-from-nikcli.json"
  const OLD = "nikcli"
  const NEW = "ragu"
  /** A config file bigger than this is not a small config: it is not backed up. */
  const SMALL = 1024 * 1024

  /** Where the folders are, as `@ragu/util/global` works them out. */
  export function roots(
    env: Record<string, string | undefined> = process.env,
    platform: NodeJS.Platform = process.platform,
    home: string = os.homedir(),
  ): Roots {
    if (platform === "win32") {
      const local = env["LOCALAPPDATA"] || path.join(home, "AppData", "Local")
      return {
        data: local,
        cache: path.join(local, "Cache"),
        config: env["APPDATA"] || path.join(home, "AppData", "Roaming"),
        state: path.join(local, "State"),
      }
    }
    return {
      data: env["XDG_DATA_HOME"] || path.join(home, ".local", "share"),
      cache: env["XDG_CACHE_HOME"] || path.join(home, ".cache"),
      config: env["XDG_CONFIG_HOME"] || path.join(home, ".config"),
      state: env["XDG_STATE_HOME"] || path.join(home, ".local", "state"),
    }
  }

  const exists = (file: string) => fs.existsSync(file)

  function forward(roots: Roots): Step[] {
    return KINDS.map((kind) => {
      const from = path.join(roots[kind], OLD)
      const to = path.join(roots[kind], NEW)
      const status: Status = exists(from) ? (exists(to) ? "both" : "move") : exists(to) ? "done" : "none"
      return { kind, from, to, status }
    })
  }

  function backward(roots: Roots): Step[] {
    return KINDS.map((kind) => {
      const from = path.join(roots[kind], NEW)
      const to = path.join(roots[kind], OLD)
      if (!exists(from)) return { kind, from, to, status: exists(to) ? "done" : "none" }
      if (exists(to)) return { kind, from, to, status: "both" }
      return { kind, from, to, status: exists(path.join(from, MARK)) ? "move" : "unmarked" }
    })
  }

  function defaults(): Deps {
    return {
      livePids: openers,
      rename: (from, to) => fs.promises.rename(from, to),
      isAlive: (pid) => {
        try {
          process.kill(pid, 0)
          return true
        } catch (error) {
          return (error as NodeJS.ErrnoException).code === "EPERM"
        }
      },
      now: () => new Date(),
    }
  }

  /**
   * Who holds `files` open: `lsof` (macOS, Linux), else `/proc` (Linux). On Windows nobody is asked: a folder
   * with an open file cannot be renamed there, and the rename reports it.
   */
  async function openers(files: string[]): Promise<number[]> {
    const present = files.filter(exists)
    if (process.platform === "win32" || present.length === 0) return []
    const lsof = Bun.spawnSync(["lsof", "-t", "--", ...present], { stderr: "ignore" })
    if (lsof.exitCode === 0 || lsof.exitCode === 1) {
      const pids = lsof.stdout.toString().split(/\s+/).filter(Boolean).map(Number)
      if (lsof.exitCode === 0 || pids.length > 0) return pids.filter((pid) => pid !== process.pid)
      if (lsof.stdout.length === 0 && lsof.exitCode === 1) return []
    }
    const wanted = new Set(present.map((file) => fs.realpathSync(file)))
    const pids: number[] = []
    for (const entry of fs.existsSync("/proc") ? fs.readdirSync("/proc") : []) {
      const pid = Number(entry)
      if (!Number.isInteger(pid) || pid === process.pid) continue
      try {
        for (const fd of fs.readdirSync(`/proc/${pid}/fd`))
          if (wanted.has(fs.readlinkSync(`/proc/${pid}/fd/${fd}`))) {
            pids.push(pid)
            break
          }
      } catch {
        // A process gone or not ours to read.
      }
    }
    return pids
  }

  /** Services registered in the state folder (`service*.json`) whose pid is alive. */
  function liveServices(stateDir: string, deps: Deps): number[] {
    if (!exists(stateDir)) return []
    const pids: number[] = []
    for (const name of fs.readdirSync(stateDir)) {
      if (!/^service.*\.json$/.test(name)) continue
      try {
        const pid = JSON.parse(fs.readFileSync(path.join(stateDir, name), "utf8"))?.pid
        if (Number.isInteger(pid) && deps.isAlive(pid)) pids.push(pid)
      } catch {
        // Not a registration.
      }
    }
    return pids
  }

  /** Moves nikcli's WAL into the database; `undefined` when done, the reason when another connection holds it. */
  function checkpoint(file: string): string | undefined {
    if (!exists(file)) return undefined
    const db = new Database(file)
    try {
      db.exec("PRAGMA busy_timeout=0")
      const row = db.query("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy: number } | null
      if (row && row.busy !== 0) return `${file} is in use (a read or a write is open in another connection)`
      return undefined
    } catch (error) {
      return `${file}: ${error instanceof Error ? error.message : String(error)}`
    } finally {
      db.close()
    }
  }

  /** auth.json and the small configs, to `<data root>/ragu-migrate-backup-<time>`, outside the folders it moves. */
  function backup(roots: Roots, steps: Step[], now: Date): string {
    const dir = path.join(roots.data, `ragu-migrate-backup-${now.toISOString().replace(/[:.]/g, "-")}`)
    const copy = (from: string, kind: Kind) => {
      fs.mkdirSync(path.join(dir, kind), { recursive: true })
      fs.copyFileSync(from, path.join(dir, kind, path.basename(from)))
    }
    const data = path.join(roots.data, OLD)
    if (exists(path.join(data, "auth.json"))) copy(path.join(data, "auth.json"), "data")
    const config = path.join(roots.config, OLD)
    for (const name of exists(config) ? fs.readdirSync(config) : []) {
      const file = path.join(config, name)
      if (/\.jsonc?$/.test(name) && fs.statSync(file).isFile() && fs.statSync(file).size <= SMALL) copy(file, "config")
    }
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, "migrate.json"), JSON.stringify({ at: now.toISOString(), steps }, null, 2))
    return dir
  }

  /** Renames `steps` in order; on a failure, renames the ones before it back and says which and why. */
  async function renameAll(steps: Step[], deps: Deps, before?: (step: Step) => void) {
    const done: Step[] = []
    for (const step of steps) {
      try {
        before?.(step)
        await deps.rename(step.from, step.to)
        done.push(step)
      } catch (error) {
        for (const back of done.toReversed()) await deps.rename(back.to, back.from).catch(() => undefined)
        const code = (error as NodeJS.ErrnoException).code
        const message = error instanceof Error ? error.message : String(error)
        return { reason: `${step.from} could not be renamed${code && !message.includes(code) ? ` (${code})` : ""}: ${message}`, path: step.from }
      }
    }
    return undefined
  }

  function liveCheck(roots: Roots, deps: Deps) {
    return async () => {
      const services = liveServices(path.join(roots.state, OLD), deps).concat(liveServices(path.join(roots.state, NEW), deps))
      if (services.length > 0) return { reason: "a ragu service is running: stop it (ragu service stop), and close ADE", pids: services }
      const db = path.join(roots.data, OLD, "nikcli.db")
      const holders = await deps.livePids([db, `${db}-wal`, `${db}-shm`])
      if (holders.length > 0) return { reason: `${db} is open in another process: close ragu, nikcli and ADE`, pids: holders }
      return undefined
    }
  }

  export async function run(input: { roots: Roots; apply: boolean; deps?: Partial<Deps> }): Promise<Report> {
    const deps = { ...defaults(), ...input.deps }
    const steps = forward(input.roots)
    const moves = steps.filter((step) => step.status === "move")
    const blocked = await liveCheck(input.roots, deps)()
    if (blocked) return { steps, applied: false, blocked }
    if (!input.apply || moves.length === 0) return { steps, applied: false }

    const busy = checkpoint(path.join(input.roots.data, OLD, "nikcli.db"))
    if (busy) return { steps, applied: false, blocked: { reason: busy } }
    const saved = backup(input.roots, steps, deps.now())
    const failed = await renameAll(moves, deps)
    if (failed) return { steps, applied: false, blocked: failed, backup: saved }
    for (const step of moves)
      fs.writeFileSync(path.join(step.to, MARK), JSON.stringify({ from: step.from, at: deps.now().toISOString() }))
    return { steps, applied: true, backup: saved }
  }

  export async function rollback(input: { roots: Roots; apply: boolean; deps?: Partial<Deps> }): Promise<Report> {
    const deps = { ...defaults(), ...input.deps }
    const steps = backward(input.roots)
    const moves = steps.filter((step) => step.status === "move")
    const services = liveServices(path.join(input.roots.state, NEW), deps)
    if (services.length > 0)
      return { steps, applied: false, blocked: { reason: "a ragu service is running: stop it, and close ADE", pids: services } }
    const db = path.join(input.roots.data, NEW, "nikcli.db")
    const holders = await deps.livePids([db, `${db}-wal`, `${db}-shm`])
    if (holders.length > 0) return { steps, applied: false, blocked: { reason: `${db} is open in another process`, pids: holders } }
    if (!input.apply || moves.length === 0) return { steps, applied: false }

    const marks = new Map<Step, string>()
    const failed = await renameAll(moves, deps, (step) => {
      const mark = path.join(step.from, MARK)
      marks.set(step, fs.readFileSync(mark, "utf8"))
      fs.rmSync(mark)
    })
    if (failed) {
      // The folders are back under ragu: their marks go back too, so a later rollback still finds them.
      for (const [step, text] of marks) if (exists(step.from)) fs.writeFileSync(path.join(step.from, MARK), text)
      return { steps, applied: false, blocked: failed }
    }
    return { steps, applied: true }
  }
}
