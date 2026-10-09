import { Database } from "bun:sqlite"
import fs from "fs"
import os from "os"
import path from "path"

/**
 * `ragu migrate`: renames a user's nikcli folders (data, cache, config, state) to ragu, once. Until it runs,
 * rule B (`@ragu/util/app-folder`) reads the nikcli ones; nothing else ever moves them.
 *
 * - A dry run by default: it says what it would move and changes nothing. `--apply` moves.
 * - Before moving: nothing may have them open or be able to make them again. A nikcli, ragu, ADE or ADE Test
 *   program running (by the name of its executable), a service whose registered pid is alive, or (macOS,
 *   Linux) a process holding nikcli.db, stops it; so does not being able to tell. On Windows a folder with an
 *   open file cannot be renamed, and the rename is the last lock check. The check runs again right before
 *   every rename. Then nikcli.db's WAL is checkpointed into the database (a read open in another connection
 *   makes that fail, and stops it), and auth.json and the small configs are copied to `migrate-backup-<time>`
 *   in the data folder, which is ragu once it has moved.
 * - Each folder is renamed inside its own parent, so on the same volume: a rename, never a copy (the data
 *   folder is gigabytes). Each carries migrate's mark (`MARK`), written before its rename, so a folder moved
 *   by a run that died halfway is still found by `--rollback`. A rename that fails undoes the ones before it;
 *   a rename back that fails too is said, folder by folder, and that folder stays moved with its mark.
 * - A folder that has both names is left alone and reported: which one is right is the user's call.
 * - `~/.nikcli` stays: its `bin/` is the installed CLI on the PATH; the installer's brief moves it.
 *
 * Undo: `ragu migrate --rollback` (a dry run) and `ragu migrate --rollback --apply` rename back every folder
 * migrate moved, found by its mark; a ragu folder without it is not touched.
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
    /**
     * `--rollback` with both names: the nikcli folder holds only empty folders or files newer than the
     * migrate, so a program without rule B made it after. Said, never merged or deleted.
     */
    readonly fresh?: boolean
  }

  export interface Blocked {
    readonly reason: string
    readonly pids?: number[]
    readonly path?: string
  }

  export interface Report {
    readonly steps: Step[]
    readonly applied: boolean
    /** The folders under their new name when it returned; after a stop, those it could not put back. */
    readonly moved: Kind[]
    readonly blocked?: Blocked
    /** The renames back that failed after a stop: each folder stays moved, with its mark. */
    readonly stuck?: { readonly path: string; readonly reason: string }[]
    readonly backup?: string
    readonly warnings: string[]
  }

  export interface Process {
    readonly pid: number
    readonly name: string
  }

  export interface Deps {
    /** Processes other than this one holding one of `files` open; `undefined` when it cannot tell. */
    livePids(files: string[]): Promise<number[] | undefined>
    /** Every running process; `undefined` when they cannot be listed. */
    processes(): Promise<Process[] | undefined>
    rename(from: string, to: string): Promise<void>
    isAlive(pid: number): boolean
    now(): Date
  }

  /** The mark migrate leaves in each folder it moves, so `--rollback` moves back only those. */
  export const MARK = "migrated-from-nikcli.json"
  /** The programs that read or write these folders: running, they stop `--apply`. */
  export const PROGRAMS = /^(?:nikcli|ragu|ade-desktop|ade-test)(?:\.exe)?$/i
  /** Said on every run: these versions do not know the ragu folders. */
  export const OLD_PROGRAMS =
    "nikcli up to 1.431.0 (fork.13) and ADE up to 0.13.0 do not know the ragu folders: started after migrate, " +
    "they make new empty nikcli folders and you look signed out with no sessions. After migrate use only ragu " +
    "and an ADE newer than 0.13.0."
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
  const message = (error: unknown) => {
    const code = (error as NodeJS.ErrnoException).code
    const text = error instanceof Error ? error.message : String(error)
    return code && !text.includes(code) ? `${text} (${code})` : text
  }

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
      if (exists(to)) return { kind, from, to, status: "both", fresh: fresh(to, path.join(from, MARK)) }
      return { kind, from, to, status: exists(path.join(from, MARK)) ? "move" : "unmarked" }
    })
  }

  /** `dir` holds only folders and files no older than the migrate that left `mark`. */
  function fresh(dir: string, mark: string): boolean {
    let at: number
    try {
      at = Date.parse(JSON.parse(fs.readFileSync(mark, "utf8")).at)
    } catch {
      return false
    }
    if (!Number.isFinite(at)) return false
    for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
      if (entry.isDirectory()) continue
      if (fs.statSync(path.join(entry.parentPath, entry.name)).mtimeMs < at) return false
    }
    return true
  }

  function defaults(): Deps {
    return {
      livePids: async (files) => openers(files),
      processes: async () => listProcesses(),
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

  /** `tasklist` on Windows, `ps` elsewhere; `undefined` when neither answers. */
  function listProcesses(): Process[] | undefined {
    try {
      if (process.platform === "win32") {
        const run = Bun.spawnSync(["tasklist", "/fo", "csv", "/nh"], { stderr: "ignore" })
        if (run.exitCode !== 0) return undefined
        return run.stdout
          .toString()
          .split(/\r?\n/)
          .flatMap((line) => {
            const cells = line.match(/"([^"]*)"/g)?.map((cell) => cell.slice(1, -1))
            const pid = Number(cells?.[1])
            return cells && Number.isInteger(pid) ? [{ pid, name: cells[0]! }] : []
          })
      }
      const run = Bun.spawnSync(["ps", "-A", "-o", "pid=,comm="], { stderr: "ignore" })
      if (run.exitCode !== 0) return undefined
      return run.stdout
        .toString()
        .split("\n")
        .flatMap((line) => {
          const found = line.trim().match(/^(\d+)\s+(.+)$/)
          return found ? [{ pid: Number(found[1]), name: path.basename(found[2]!) }] : []
        })
    } catch {
      return undefined
    }
  }

  /**
   * Who holds `files` open: `lsof` when it answers, else `/proc`; `undefined` when neither can tell. `lsof`
   * exits 1 both when nobody holds them and on some errors: only an empty answer with 1 counts as nobody.
   */
  export function openersFrom(
    files: string[],
    ask: { lsof(files: string[]): { code: number; out: string } | undefined; proc(files: string[]): number[] | undefined },
  ): number[] | undefined {
    const lsof = ask.lsof(files)
    if (lsof && (lsof.code === 0 || lsof.code === 1)) {
      const pids = lsof.out.split(/\s+/).filter(Boolean).map(Number)
      if (lsof.code === 0 || pids.length === 0) return pids.filter((pid) => pid !== process.pid)
    }
    return ask.proc(files)
  }

  /** On Windows nobody is asked: a folder with an open file cannot be renamed there, and the rename says it. */
  function openers(files: string[]): number[] | undefined {
    const present = files.filter(exists)
    if (process.platform === "win32" || present.length === 0) return []
    return openersFrom(present, {
      lsof: (files) => {
        try {
          const run = Bun.spawnSync(["lsof", "-t", "--", ...files], { stderr: "ignore" })
          return { code: run.exitCode ?? -1, out: run.stdout.toString() }
        } catch {
          return undefined
        }
      },
      proc: (files) => {
        if (!exists("/proc/self/fd")) return undefined
        const wanted = new Set(files.map((file) => fs.realpathSync(file)))
        const pids: number[] = []
        for (const entry of fs.readdirSync("/proc")) {
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
      },
    })
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
      return `${file}: ${message(error)}`
    } finally {
      db.close()
    }
  }

  /**
   * auth.json and the small configs, to `migrate-backup-<time>` in the data folder that is ragu after the run:
   * written into the nikcli one when that is the one moving, so it travels with it.
   */
  function backup(roots: Roots, steps: Step[], now: Date): string {
    const data = steps.find((step) => step.kind === "data")!
    const name = `migrate-backup-${now.toISOString().replace(/[:.]/g, "-")}`
    const dir = path.join(data.status === "move" ? data.from : data.to, name)
    const copy = (from: string, kind: Kind) => {
      fs.mkdirSync(path.join(dir, kind), { recursive: true })
      fs.copyFileSync(from, path.join(dir, kind, path.basename(from)))
    }
    const auth = path.join(roots.data, OLD, "auth.json")
    if (exists(auth)) copy(auth, "data")
    const config = path.join(roots.config, OLD)
    for (const name of exists(config) ? fs.readdirSync(config) : []) {
      const file = path.join(config, name)
      if (/\.jsonc?$/.test(name) && fs.statSync(file).isFile() && fs.statSync(file).size <= SMALL) copy(file, "config")
    }
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, "migrate.json"), JSON.stringify({ at: now.toISOString(), steps }, null, 2))
    return name
  }

  /**
   * Renames `steps` in order, checking again right before each. On a stop or a failed rename, renames the
   * ones before it back, and says which could not be.
   */
  async function renameAll(
    steps: Step[],
    deps: Deps,
    hooks: {
      check(): Promise<Blocked | undefined>
      /** Before a rename. */
      prepare?(step: Step): void
      /** After a rename that did not happen, or was undone. */
      unprepare?(step: Step): void
    },
  ) {
    const done: Step[] = []
    const stop = async (blocked: Blocked) => {
      const stuck: { path: string; reason: string }[] = []
      for (const back of done.toReversed()) {
        try {
          await deps.rename(back.to, back.from)
          done.splice(done.indexOf(back), 1)
          hooks.unprepare?.(back)
        } catch (error) {
          stuck.push({ path: back.to, reason: message(error) })
        }
      }
      return { blocked, moved: done, stuck }
    }
    for (const step of steps) {
      const blocked = await hooks.check()
      if (blocked) return stop(blocked)
      try {
        hooks.prepare?.(step)
        await deps.rename(step.from, step.to)
        done.push(step)
      } catch (error) {
        if (!exists(step.to)) hooks.unprepare?.(step)
        return stop({ reason: `${step.from} could not be renamed: ${message(error)}`, path: step.from })
      }
    }
    return { blocked: undefined, moved: done, stuck: [] }
  }

  /** What stops `--apply`: a program running, a live service, a process holding the db, or not knowing. */
  function liveCheck(roots: Roots, deps: Deps, db: string) {
    return async (): Promise<Blocked | undefined> => {
      const services = liveServices(path.join(roots.state, OLD), deps).concat(liveServices(path.join(roots.state, NEW), deps))
      if (services.length > 0) return { reason: "a ragu service is running: stop it (ragu service stop), and close ADE", pids: services }
      const all = await deps.processes()
      if (!all) return { reason: "cannot tell which programs are running (the process list did not answer)" }
      const running = all.filter((proc) => proc.pid !== process.pid && PROGRAMS.test(proc.name))
      if (running.length > 0)
        return {
          reason: `close these first, they read and write the folders: ${running.map((proc) => `${proc.name} (${proc.pid})`).join(", ")}`,
          pids: running.map((proc) => proc.pid),
        }
      const holders = await deps.livePids([db, `${db}-wal`, `${db}-shm`])
      if (!holders) return { reason: `cannot tell whether ${db} is open (lsof did not answer and there is no /proc)` }
      if (holders.length > 0) return { reason: `${db} is open in another process: close ragu, nikcli and ADE`, pids: holders }
      return undefined
    }
  }

  const kinds = (steps: Step[]) => steps.map((step) => step.kind)

  export async function run(input: { roots: Roots; apply: boolean; deps?: Partial<Deps> }): Promise<Report> {
    const deps = { ...defaults(), ...input.deps }
    const warnings = [OLD_PROGRAMS]
    const steps = forward(input.roots)
    const moves = steps.filter((step) => step.status === "move")
    const db = path.join(input.roots.data, OLD, "nikcli.db")
    const check = liveCheck(input.roots, deps, db)
    const blocked = await check()
    if (blocked) return { steps, applied: false, moved: [], blocked, warnings }
    if (!input.apply || moves.length === 0) return { steps, applied: false, moved: [], warnings }

    const busy = checkpoint(db)
    if (busy) return { steps, applied: false, moved: [], blocked: { reason: busy }, warnings }
    const saved = backup(input.roots, steps, deps.now())
    const mark = (step: Step) => path.join(step.from, MARK)
    const result = await renameAll(moves, deps, {
      check,
      prepare: (step) => fs.writeFileSync(mark(step), JSON.stringify({ from: step.from, at: deps.now().toISOString() })),
      unprepare: (step) => fs.rmSync(mark(step), { force: true }),
    })
    const data = steps.find((step) => step.kind === "data")!
    const backupAt = path.join(data.status !== "move" || result.moved.includes(data) ? data.to : data.from, saved)
    if (result.blocked)
      return {
        steps,
        applied: false,
        moved: kinds(result.moved),
        blocked: result.blocked,
        ...(result.stuck.length ? { stuck: result.stuck } : {}),
        backup: backupAt,
        warnings,
      }
    return { steps, applied: true, moved: kinds(result.moved), backup: backupAt, warnings }
  }

  export async function rollback(input: { roots: Roots; apply: boolean; deps?: Partial<Deps> }): Promise<Report> {
    const deps = { ...defaults(), ...input.deps }
    const warnings = [OLD_PROGRAMS]
    const steps = backward(input.roots)
    const moves = steps.filter((step) => step.status === "move")
    const check = liveCheck(input.roots, deps, path.join(input.roots.data, NEW, "nikcli.db"))
    const blocked = await check()
    if (blocked) return { steps, applied: false, moved: [], blocked, warnings }
    if (!input.apply || moves.length === 0) return { steps, applied: false, moved: [], warnings }

    // The marks stay until every folder is back, so a stop leaves each one where a later rollback finds it.
    const result = await renameAll(moves, deps, { check })
    if (result.blocked)
      return {
        steps,
        applied: false,
        moved: kinds(result.moved),
        blocked: result.blocked,
        ...(result.stuck.length ? { stuck: result.stuck } : {}),
        warnings,
      }
    // Back under nikcli, the marks go; so does one a run that died left in a folder it never renamed.
    for (const kind of KINDS) {
      const old = path.join(input.roots[kind], OLD)
      if (!exists(path.join(input.roots[kind], NEW))) fs.rmSync(path.join(old, MARK), { force: true })
    }
    return { steps, applied: true, moved: kinds(result.moved), warnings }
  }
}
