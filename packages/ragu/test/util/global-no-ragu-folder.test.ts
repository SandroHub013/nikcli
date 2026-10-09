import { afterAll, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"

/*
 * Review of correction 2, point 1: nothing makes a `ragu` folder by itself; only the user or `ragu migrate`
 * does. `Global.initialize()` makes the data, cache, config, state, log, bin and repos folders at every start:
 * by rule B they are the `nikcli` ones while no `ragu` one exists. Run in a child process, so `Global` works out
 * its folders from a home of its own (APPDATA, LOCALAPPDATA and XDG under it) and not from the test home.
 */
const made: string[] = []
afterAll(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true })
})

function start(home: string) {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) }
  for (const key of Object.keys(env)) if (/^(RAGU_|NIKCLI_|XDG_)/.test(key)) delete env[key]
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(home, "AppData", "Local"),
  })
  const script = `const g = await import("@ragu/util/global"); await g.initialize(); console.log(JSON.stringify(g.Global.Path))`
  const run = Bun.spawnSync([process.execPath, "-e", script], { cwd: path.join(import.meta.dir, "../.."), env })
  expect(run.exitCode).toBe(0)
  return JSON.parse(run.stdout.toString().trim().split("\n").pop()!) as Record<string, string>
}

function every(root: string): string[] {
  return fs.readdirSync(root, { recursive: true, withFileTypes: true }).map((entry) =>
    path.relative(root, path.join(entry.parentPath, entry.name)).replaceAll("\\", "/"),
  )
}

describe("a start never makes a ragu folder", () => {
  test("with the nikcli folders only, every folder the start makes is a nikcli one", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ragu-first-start-"))
    made.push(home)
    for (const dir of ["AppData/Roaming/nikcli", "AppData/Local/nikcli", ".config/nikcli", ".local/share/nikcli", ".nikcli"])
      fs.mkdirSync(path.join(home, dir), { recursive: true })
    const paths = start(home)
    expect(every(home).filter((file) => /(^|\/)\.?ragu(\/|$)/.test(file))).toEqual([])
    expect(path.basename(paths["config"]!)).toBe("nikcli")
    expect(path.basename(paths["data"]!)).toBe("nikcli")
    // The child worked out its folders from this home, not from the test one.
    for (const name of ["config", "data", "cache", "state"]) expect([name, paths[name]!.startsWith(home)]).toEqual([name, true])
  })

  test("with nothing yet, the old name too", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ragu-first-start-"))
    made.push(home)
    start(home)
    expect(every(home).filter((file) => /(^|\/)\.?ragu(\/|$)/.test(file))).toEqual([])
  })
})
