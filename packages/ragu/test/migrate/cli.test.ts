import { afterAll, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"

/*
 * `ragu migrate` through the real CLI, in a child whose home, APPDATA, LOCALAPPDATA and XDG folders are a fake
 * one under the temp folder: never the user's. The CLI's own start writes its log under the data folder; for
 * migrate it must not, or on Windows the process would hold open the folder it renames.
 */
const made: string[] = []
afterAll(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true })
})

function cli(home: string, ...args: string[]) {
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
  })
  const run = Bun.spawnSync([process.execPath, "run", "src/index.ts", "migrate", ...args], {
    cwd: path.join(import.meta.dir, "../.."),
    env,
  })
  return { code: run.exitCode, out: run.stdout.toString() + run.stderr.toString() }
}

describe("ragu migrate, the command", () => {
  test("a dry run, then --apply, then --rollback --apply, on a fake home", () => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ragu-migrate-cli-")))
    made.push(home)
    const local = path.join(home, "AppData", "Local")
    const roaming = path.join(home, "AppData", "Roaming")
    fs.mkdirSync(path.join(local, "nikcli", "storage"), { recursive: true })
    fs.writeFileSync(path.join(local, "nikcli", "storage", "s.json"), "{}")
    fs.mkdirSync(path.join(roaming, "nikcli"), { recursive: true })
    fs.writeFileSync(path.join(roaming, "nikcli", "nikcli.json"), "{}")

    const dry = cli(home, "--json")
    expect(dry.code).toBe(0)
    expect(fs.existsSync(path.join(local, "ragu"))).toBe(false)

    const applied = cli(home, "--apply", "--json")
    expect([applied.code, applied.out]).toEqual([0, expect.stringContaining('"applied": true')])
    expect(fs.readFileSync(path.join(local, "ragu", "storage", "s.json"), "utf8")).toBe("{}")
    expect(fs.existsSync(path.join(roaming, "ragu", "nikcli.json"))).toBe(true)
    expect(fs.existsSync(path.join(local, "nikcli"))).toBe(false)

    const undone = cli(home, "--rollback", "--apply", "--json")
    expect([undone.code, undone.out]).toEqual([0, expect.stringContaining('"applied": true')])
    expect(fs.readFileSync(path.join(local, "nikcli", "storage", "s.json"), "utf8")).toBe("{}")
    expect(fs.existsSync(path.join(local, "ragu"))).toBe(false)
  }, 120_000)
})
