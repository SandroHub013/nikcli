import { afterAll, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"

/*
 * `ragu migrate` through the real CLI, in a child whose home, APPDATA, LOCALAPPDATA and XDG folders are a fake
 * one under the temp folder: never the user's. The CLI's own start makes its folders and writes its log under
 * the data folder; for migrate it must not, or a dry run would change the disk and on Windows the process would
 * hold open the folder it renames.
 */
const made: string[] = []
afterAll(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true })
})

/** The programs the child sees running: none by default, whatever runs on the machine that runs the tests. */
function cli(home: string, args: string[], running: { pid: number; name: string }[] = []) {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) }
  for (const key of Object.keys(env)) if (/^(RAGU_|NIKCLI_|XDG_)/.test(key)) delete env[key]
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(home, "AppData", "Local"),
    XDG_DATA_HOME: path.join(home, "AppData", "Local"),
    XDG_CACHE_HOME: path.join(home, "AppData", "Local", "Cache"),
    XDG_CONFIG_HOME: path.join(home, "AppData", "Roaming"),
    XDG_STATE_HOME: path.join(home, "AppData", "Local", "State"),
    RAGU_TEST_HOME: home,
    RAGU_TEST_MIGRATE_RUNNING: JSON.stringify(running),
    // Bun running the sources keeps its transpiler cache in XDG_CACHE_HOME: that is bun, not ragu, writing.
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
  })
  const run = Bun.spawnSync([process.execPath, "run", "src/index.ts", "migrate", ...args], {
    cwd: path.join(import.meta.dir, "../.."),
    env,
  })
  return { code: run.exitCode, out: run.stdout.toString() + run.stderr.toString() }
}

/** Every folder and file under `root`, with the files' bytes. */
function print(root: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const entry of fs.readdirSync(root, { recursive: true, withFileTypes: true })) {
    const full = path.join(entry.parentPath, entry.name)
    out[path.relative(root, full).replaceAll("\\", "/")] = entry.isFile() ? fs.readFileSync(full, "latin1") : "<dir>"
  }
  return out
}

function fakeHome() {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ragu-migrate-cli-")))
  made.push(home)
  const local = path.join(home, "AppData", "Local")
  const roaming = path.join(home, "AppData", "Roaming")
  fs.mkdirSync(path.join(local, "nikcli", "storage"), { recursive: true })
  fs.writeFileSync(path.join(local, "nikcli", "storage", "s.json"), "{}")
  fs.mkdirSync(path.join(roaming, "nikcli"), { recursive: true })
  fs.writeFileSync(path.join(roaming, "nikcli", "nikcli.json"), "{}")
  return { home, local, roaming }
}

describe("ragu migrate, the command", () => {
  test("a dry run leaves the home byte for byte as it was: no folder made, no log, no cache emptied", () => {
    const { home } = fakeHome()
    const before = print(home)
    const dry = cli(home, ["--json"])
    expect(dry.code).toBe(0)
    expect(print(home)).toEqual(before)
  }, 120_000)

  test("a dry run, then --apply, then --rollback --apply, on a fake home", () => {
    const { home, local, roaming } = fakeHome()

    const dry = cli(home, ["--json"])
    expect(dry.code).toBe(0)
    expect(fs.existsSync(path.join(local, "ragu"))).toBe(false)

    const applied = cli(home, ["--apply", "--json"])
    expect([applied.code, applied.out]).toEqual([0, expect.stringContaining('"applied": true')])
    expect(fs.readFileSync(path.join(local, "ragu", "storage", "s.json"), "utf8")).toBe("{}")
    expect(fs.existsSync(path.join(roaming, "ragu", "nikcli.json"))).toBe(true)
    expect(fs.existsSync(path.join(local, "nikcli"))).toBe(false)

    const undone = cli(home, ["--rollback", "--apply", "--json"])
    expect([undone.code, undone.out]).toEqual([0, expect.stringContaining('"applied": true')])
    expect(fs.readFileSync(path.join(local, "nikcli", "storage", "s.json"), "utf8")).toBe("{}")
    expect(fs.existsSync(path.join(local, "ragu"))).toBe(false)
  }, 120_000)

  test("--apply with ADE running stops, names it, and moves nothing", () => {
    const { home } = fakeHome()
    const before = print(home)
    const stopped = cli(home, ["--apply"], [{ pid: 4321, name: "ade-desktop.exe" }])
    expect(stopped.code).toBe(1)
    expect(stopped.out).toContain("ade-desktop.exe")
    expect(stopped.out).toContain("4321")
    expect(print(home)).toEqual(before)
  }, 120_000)
})
