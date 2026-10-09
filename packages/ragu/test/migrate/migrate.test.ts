import { Database } from "bun:sqlite"
import { afterAll, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Migrate } from "../../src/migrate/migrate"

/*
 * `ragu migrate` (brief ragu-code-rebrand, Master's decisions): it renames the nikcli folders to ragu on the
 * same volume, after checking that nothing has them open, a WAL checkpoint of nikcli.db and a backup of
 * auth.json and the small configs. A dry run by default, `--apply` to do it, `--rollback` to undo it.
 * Every test runs on a fake home under the temp folder: never the user's folders.
 */
const made: string[] = []
afterAll(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true })
})

/** A fake home with the nikcli folders of a Windows machine, under bases the test owns. */
function home(files: Record<string, string> = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ragu-migrate-")))
  made.push(root)
  const roots: Migrate.Roots = {
    data: path.join(root, "Local"),
    cache: path.join(root, "Local", "Cache"),
    config: path.join(root, "Roaming"),
    state: path.join(root, "Local", "State"),
  }
  const all: Record<string, string> = {
    "Local/nikcli/storage/session/a.json": "{}",
    "Local/nikcli/auth.json": '{"openrouter":{"key":"finta"}}',
    "Local/Cache/nikcli/models.json": "{}",
    "Roaming/nikcli/nikcli.json": '{"theme":"x"}',
    "Roaming/nikcli/tui.json": "{}",
    "Local/State/nikcli/kv.json": "{}",
    ...files,
  }
  for (const [file, text] of Object.entries(all)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    fs.writeFileSync(path.join(root, file), text)
  }
  return { root, roots }
}

/** Every file under `root` with its content. */
function tree(root: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const entry of fs.readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue
    const full = path.join(entry.parentPath, entry.name)
    out[path.relative(root, full).replaceAll("\\", "/")] = fs.readFileSync(full, "latin1")
  }
  return out
}

/** `tree` without the backup, which the test checks apart. */
const kept = (all: Record<string, string>) =>
  Object.fromEntries(Object.entries(all).filter(([file]) => !file.includes("migrate-backup-")))

const quiet: Partial<Migrate.Deps> = { livePids: async () => [], processes: async () => [] }

describe("where the folders are", () => {
  test("Windows: LOCALAPPDATA, its Cache and State, and APPDATA", () => {
    const roots = Migrate.roots({ LOCALAPPDATA: "C:/L", APPDATA: "C:/R" }, "win32", "C:/Users/u")
    expect(roots).toEqual({
      data: "C:/L",
      cache: path.join("C:/L", "Cache"),
      config: "C:/R",
      state: path.join("C:/L", "State"),
    })
  })

  test("elsewhere: the XDG folders, else their defaults under the home", () => {
    expect(Migrate.roots({ XDG_DATA_HOME: "/x/d" }, "linux", "/home/u")).toEqual({
      data: "/x/d",
      cache: path.join("/home/u", ".cache"),
      config: path.join("/home/u", ".config"),
      state: path.join("/home/u", ".local", "state"),
    })
  })
})

describe("the dry run", () => {
  test("says what it would move and changes nothing", async () => {
    const { root, roots } = home()
    const before = tree(root)
    const report = await Migrate.run({ roots, apply: false, deps: quiet })
    expect(report.applied).toBe(false)
    expect(report.blocked).toBeUndefined()
    expect(report.moved).toEqual([])
    expect(report.steps.map((step) => [step.kind, step.status])).toEqual([
      ["data", "move"],
      ["cache", "move"],
      ["config", "move"],
      ["state", "move"],
    ])
    expect(tree(root)).toEqual(before)
  })

  test("a folder that has both names is left alone and said; one already ragu is done", async () => {
    const { roots } = home({ "Roaming/ragu/ragu.json": "{}", "Local/State/ragu/kv.json": "{}" })
    fs.rmSync(path.join(roots.state, "nikcli"), { recursive: true })
    const report = await Migrate.run({ roots, apply: false, deps: quiet })
    expect(Object.fromEntries(report.steps.map((step) => [step.kind, step.status]))).toEqual({
      data: "move",
      cache: "move",
      config: "both",
      state: "done",
    })
  })

  test("warns that the programs without rule B start empty after it, and names their versions", async () => {
    const { roots } = home()
    const dry = await Migrate.run({ roots, apply: false, deps: quiet })
    const applied = await Migrate.run({ roots, apply: true, deps: quiet })
    for (const report of [dry, applied]) {
      expect(report.warnings).toEqual([Migrate.OLD_PROGRAMS])
      expect(Migrate.OLD_PROGRAMS).toContain("1.431.0")
      expect(Migrate.OLD_PROGRAMS).toContain("0.13.0")
    }
  })
})

describe("--apply", () => {
  test("renames every nikcli folder to ragu with all it holds, and backs up auth.json and the small configs in the new data folder", async () => {
    const { root, roots } = home()
    const before = tree(root)
    const report = await Migrate.run({ roots, apply: true, deps: quiet })
    expect(report.blocked).toBeUndefined()
    expect(report.applied).toBe(true)
    expect(report.moved).toEqual(["data", "cache", "config", "state"])
    const after = tree(root)
    // Every file is where the rename puts it, unchanged; nothing is left under a nikcli folder.
    for (const [file, text] of Object.entries(before)) {
      const moved = file.replace(/(^|\/)nikcli\//, "$1ragu/")
      expect([moved, after[moved]]).toEqual([moved, text])
    }
    expect(Object.keys(after).filter((file) => /(^|\/)nikcli\//.test(file))).toEqual([])
    // The backup sits in the ragu data folder, where it is now.
    const backup = report.backup!
    expect(path.dirname(backup)).toBe(path.join(roots.data, "ragu"))
    expect(path.basename(backup)).toStartWith("migrate-backup-")
    expect(fs.readFileSync(path.join(backup, "data", "auth.json"), "utf8")).toBe(before["Local/nikcli/auth.json"]!)
    expect(fs.readFileSync(path.join(backup, "config", "nikcli.json"), "utf8")).toBe(before["Roaming/nikcli/nikcli.json"]!)
  })

  test("a running service (its pid alive) stops it before anything changes", async () => {
    const { root, roots } = home({ "Local/State/nikcli/service.json": JSON.stringify({ pid: process.pid, url: "http://x" }) })
    const before = tree(root)
    const report = await Migrate.run({ roots, apply: true, deps: quiet })
    expect(report.applied).toBe(false)
    expect(report.blocked?.pids).toEqual([process.pid])
    expect(tree(root)).toEqual(before)
  })

  test("a process that holds nikcli.db open stops it", async () => {
    const { root, roots } = home({ "Local/nikcli/nikcli.db": "" })
    const before = tree(root)
    const report = await Migrate.run({ roots, apply: true, deps: { ...quiet, livePids: async () => [4242] } })
    expect(report.applied).toBe(false)
    expect(report.blocked?.pids).toEqual([4242])
    expect(tree(root)).toEqual(before)
  })

  test("when who holds nikcli.db cannot be told (lsof failed, no /proc), it stops", async () => {
    const { root, roots } = home({ "Local/nikcli/nikcli.db": "" })
    const before = tree(root)
    const report = await Migrate.run({ roots, apply: true, deps: { ...quiet, livePids: async () => undefined } })
    expect(report.applied).toBe(false)
    expect(report.blocked?.reason).toContain("cannot tell")
    expect(tree(root)).toEqual(before)
  })

  test("a nikcli, ragu, ADE or ADE Test program running stops it; this process does not", async () => {
    const { root, roots } = home()
    const before = tree(root)
    for (const name of ["nikcli.exe", "ragu", "ade-desktop.exe", "ADE-TEST.EXE"]) {
      const processes = async () => [
        { pid: process.pid, name: "ragu.exe" },
        { pid: 77, name },
        { pid: 78, name: "bun.exe" },
      ]
      const report = await Migrate.run({ roots, apply: true, deps: { ...quiet, processes } })
      expect([name, report.applied, report.blocked?.pids]).toEqual([name, false, [77]])
    }
    expect(tree(root)).toEqual(before)
  })

  test("when the running programs cannot be listed, it stops", async () => {
    const { root, roots } = home()
    const before = tree(root)
    const report = await Migrate.run({ roots, apply: true, deps: { ...quiet, processes: async () => undefined } })
    expect(report.applied).toBe(false)
    expect(report.blocked?.reason).toContain("cannot tell")
    expect(tree(root)).toEqual(before)
  })

  test("the check runs again before every rename: a program started after the first one stops it, and that one is put back", async () => {
    const { root, roots } = home()
    const before = tree(root)
    let renames = 0
    const rename = async (from: string, to: string) => {
      renames++
      fs.renameSync(from, to)
    }
    const processes = async () => (renames >= 1 ? [{ pid: 91, name: "nikcli.exe" }] : [])
    const report = await Migrate.run({ roots, apply: true, deps: { ...quiet, processes, rename } })
    expect(report.applied).toBe(false)
    expect(report.blocked?.pids).toEqual([91])
    expect(report.moved).toEqual([])
    expect(kept(tree(root))).toEqual(before)
  })

  test("the WAL of nikcli.db is checkpointed into the database before the move", async () => {
    const { roots } = home()
    const file = path.join(roots.data, "nikcli", "nikcli.db")
    const db = new Database(file)
    db.exec("PRAGMA journal_mode=WAL; CREATE TABLE t (x); INSERT INTO t VALUES (1), (2)")
    db.exec("PRAGMA wal_autocheckpoint=0; INSERT INTO t VALUES (3)")
    db.close(false)
    const report = await Migrate.run({ roots, apply: true, deps: quiet })
    expect(report.blocked).toBeUndefined()
    const moved = path.join(roots.data, "ragu", "nikcli.db")
    expect(fs.existsSync(`${moved}-wal`) ? fs.statSync(`${moved}-wal`).size : 0).toBe(0)
    const read = new Database(moved, { readonly: true })
    expect(read.query("SELECT count(*) AS n FROM t").get()).toEqual({ n: 3 })
    read.close()
  })

  test("a real nikcli.db left in WAL by a killed process: checkpointed, and the rename then succeeds (the file is let go)", async () => {
    const { root, roots } = home()
    const file = path.join(roots.data, "nikcli", "nikcli.db")
    // A writer that dies without closing: its rows stay in the -wal file, as after a crash.
    const script = path.join(root, "writer.ts")
    fs.writeFileSync(
      script,
      [
        'import { Database } from "bun:sqlite"',
        "const db = new Database(process.argv[2])",
        'db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE t (x); INSERT INTO t VALUES (1), (2), (3)")',
        'process.stdout.write("ready\\n")',
        "setInterval(() => {}, 1000)",
      ].join("\n"),
    )
    const writer = Bun.spawn([process.execPath, script, file], { stdout: "pipe", stderr: "ignore" })
    const reader = writer.stdout.getReader()
    let said = ""
    while (!said.includes("ready")) {
      const chunk = await reader.read()
      if (chunk.done) break
      said += new TextDecoder().decode(chunk.value)
    }
    writer.kill(9)
    await writer.exited
    expect(fs.statSync(`${file}-wal`).size).toBeGreaterThan(0)

    const report = await Migrate.run({ roots, apply: true, deps: quiet })
    expect(report.blocked).toBeUndefined()
    expect(report.applied).toBe(true)
    const moved = path.join(roots.data, "ragu", "nikcli.db")
    expect(fs.existsSync(`${moved}-wal`) ? fs.statSync(`${moved}-wal`).size : 0).toBe(0)
    const read = new Database(moved, { readonly: true })
    expect(read.query("SELECT count(*) AS n FROM t").get()).toEqual({ n: 3 })
    read.close()
  })

  test("a database in use (a read open in another connection) stops it", async () => {
    const { root, roots } = home()
    const file = path.join(roots.data, "nikcli", "nikcli.db")
    const writer = new Database(file)
    writer.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE t (x); INSERT INTO t VALUES (1)")
    const reader = new Database(file)
    reader.exec("BEGIN")
    reader.query("SELECT * FROM t").all()
    try {
      // The checkpoint copies what it can into the database before it reports the reader: the same rows, other
      // bytes. Every other file stays as it was, and nothing moves.
      const files = (all: Record<string, string>) => Object.fromEntries(Object.entries(all).filter(([file]) => !file.includes("nikcli.db")))
      const before = files(tree(root))
      const report = await Migrate.run({ roots, apply: true, deps: quiet })
      expect(report.applied).toBe(false)
      expect(report.blocked?.reason).toContain("nikcli.db")
      expect(files(tree(root))).toEqual(before)
      expect(reader.query("SELECT count(*) AS n FROM t").get()).toEqual({ n: 1 })
    } finally {
      reader.exec("COMMIT")
      reader.close()
      writer.close()
    }
  })

  test("a folder that cannot be renamed (a file locked) undoes the renames before it, and says which", async () => {
    const { root, roots } = home()
    const before = tree(root)
    const rename = async (from: string, to: string) => {
      if (from === path.join(roots.config, "nikcli")) throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" })
      fs.renameSync(from, to)
    }
    const report = await Migrate.run({ roots, apply: true, deps: { ...quiet, rename } })
    expect(report.applied).toBe(false)
    expect(report.blocked?.path).toBe(path.join(roots.config, "nikcli"))
    expect(report.blocked?.reason).toContain("EBUSY")
    expect(report.moved).toEqual([])
    // Every folder is back under nikcli, as it was, without a mark; only the backup is new.
    expect(kept(tree(root))).toEqual(before)
  })

  test("renames back that fail are said one by one, with the folders still moved", async () => {
    const { roots } = home()
    let renames = 0
    const rename = async (from: string, to: string) => {
      renames++
      if (renames >= 3) throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" })
      fs.renameSync(from, to)
    }
    const report = await Migrate.run({ roots, apply: true, deps: { ...quiet, rename } })
    expect(report.applied).toBe(false)
    expect(report.blocked?.path).toBe(path.join(roots.config, "nikcli"))
    expect(report.moved).toEqual(["data", "cache"])
    expect(report.stuck?.map((stuck) => stuck.path)).toEqual([path.join(roots.cache, "ragu"), path.join(roots.data, "ragu")])
    expect(report.stuck?.every((stuck) => stuck.reason.includes("EPERM"))).toBe(true)
    // They carry the mark: --rollback finds them.
    const back = await Migrate.rollback({ roots, apply: false, deps: quiet })
    expect(Object.fromEntries(back.steps.map((step) => [step.kind, step.status]))).toMatchObject({ data: "move", cache: "move" })
  })

  test("killed between two renames: the folders already moved carry the mark, and --rollback puts everything back", async () => {
    const { root, roots } = home()
    const before = tree(root)
    let renames = 0
    // The third rename never returns: the process is gone from there on.
    const rename = (from: string, to: string) => {
      renames++
      if (renames >= 3) return new Promise<void>(() => {})
      fs.renameSync(from, to)
      return Promise.resolve()
    }
    void Migrate.run({ roots, apply: true, deps: { ...quiet, rename } })
    while (renames < 3) await Bun.sleep(5)
    expect(fs.existsSync(path.join(roots.data, "ragu", Migrate.MARK))).toBe(true)
    expect(fs.existsSync(path.join(roots.cache, "ragu", Migrate.MARK))).toBe(true)

    const undone = await Migrate.rollback({ roots, apply: true, deps: quiet })
    expect(undone.applied).toBe(true)
    expect(undone.moved).toEqual(["data", "cache"])
    expect(kept(tree(root))).toEqual(before)
  })
})

describe("--rollback", () => {
  test("renames back what migrate moved, and only that", async () => {
    const { root, roots } = home()
    const before = tree(root)
    await Migrate.run({ roots, apply: true, deps: quiet })
    // A ragu folder the user made, which migrate did not move: not touched.
    fs.mkdirSync(path.join(roots.data, "Other", "ragu"), { recursive: true })
    const dry = await Migrate.rollback({ roots, apply: false, deps: quiet })
    expect(dry.steps.every((step) => step.status === "move")).toBe(true)
    const undone = await Migrate.rollback({ roots, apply: true, deps: quiet })
    expect(undone.applied).toBe(true)
    expect(kept(tree(root))).toEqual(before)
  })

  test("a ragu folder without migrate's mark is not rolled back", async () => {
    const { roots } = home()
    fs.renameSync(path.join(roots.state, "nikcli"), path.join(roots.state, "ragu"))
    const report = await Migrate.rollback({ roots, apply: false, deps: quiet })
    expect(report.steps.find((step) => step.kind === "state")?.status).toBe("unmarked")
  })

  test("a nikcli folder made after migrate (only empty folders or newer files) is said as fresh; one with older files is not; neither is touched", async () => {
    const { root, roots } = home()
    await Migrate.run({ roots, apply: true, deps: quiet })
    // An old nikcli or ADE started after migrate: it makes empty folders and new files.
    fs.mkdirSync(path.join(roots.data, "nikcli", "log"), { recursive: true })
    fs.mkdirSync(path.join(roots.config, "nikcli"), { recursive: true })
    fs.writeFileSync(path.join(roots.config, "nikcli", "nikcli.json"), "{}")
    // A cache folder with a file older than migrate: not something an old program just made.
    fs.mkdirSync(path.join(roots.cache, "nikcli"), { recursive: true })
    fs.writeFileSync(path.join(roots.cache, "nikcli", "old.json"), "{}")
    fs.utimesSync(path.join(roots.cache, "nikcli", "old.json"), new Date(2020, 0, 1), new Date(2020, 0, 1))
    const before = tree(root)
    const report = await Migrate.rollback({ roots, apply: true, deps: quiet })
    const by = Object.fromEntries(report.steps.map((step) => [step.kind, [step.status, step.fresh ?? false]]))
    expect(by).toEqual({ data: ["both", true], cache: ["both", false], config: ["both", true], state: ["move", false] })
    // Nothing merged or deleted: the both folders are as they were.
    const after = tree(root)
    for (const file of Object.keys(before).filter((file) => !file.startsWith("Local/State/"))) expect(after[file]).toBe(before[file]!)
  })
})

describe("who holds nikcli.db, on macOS and Linux", () => {
  const files = ["/d/nikcli.db"]
  test("lsof's answer when it runs", () => {
    expect(Migrate.openersFrom(files, { lsof: () => ({ code: 0, out: "12\n13\n" }), proc: () => [99] })).toEqual([12, 13])
    expect(Migrate.openersFrom(files, { lsof: () => ({ code: 1, out: "" }), proc: () => [99] })).toEqual([])
  })

  test("lsof missing or failing: /proc", () => {
    expect(Migrate.openersFrom(files, { lsof: () => undefined, proc: () => [99] })).toEqual([99])
    expect(Migrate.openersFrom(files, { lsof: () => ({ code: 2, out: "" }), proc: () => [99] })).toEqual([99])
  })

  test("neither: it cannot tell", () => {
    expect(Migrate.openersFrom(files, { lsof: () => undefined, proc: () => undefined })).toBeUndefined()
  })
})
