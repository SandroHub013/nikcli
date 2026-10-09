import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"
import { Global } from "@ragu/util/global"
import { runDoctorChecks } from "../../src/doctor/checks"

/*
 * `doctor` checked `config.json`, a file ragu never reads: the user's config is `ragu.json`, else
 * `nikcli.json` (rule B, `@ragu/util/app-folder`), the file `Config.global()` loads.
 */
const NAMES = ["config.json", "ragu.json", "ragu.jsonc", "nikcli.json"]
const at = (name: string) => path.join(Global.Path.config, name)

async function checks() {
  const { results } = await runDoctorChecks()
  return {
    config: results.find((result) => result.label === "Config")!,
    deprecated: results.find((result) => result.label === "Deprecated keys")!,
  }
}

describe("doctor reads the config file ragu reads", () => {
  afterEach(() => {
    for (const name of NAMES) fs.rmSync(at(name), { force: true })
  })

  test("nikcli.json when there is no ragu.json", async () => {
    fs.mkdirSync(Global.Path.config, { recursive: true })
    fs.writeFileSync(at("nikcli.json"), "{ not json")
    const { config } = await checks()
    expect(config.ok).toBe(false)
    expect(config.detail).toContain(at("nikcli.json"))
  })

  test("ragu.json first, when it is there", async () => {
    fs.mkdirSync(Global.Path.config, { recursive: true })
    fs.writeFileSync(at("nikcli.json"), "{ not json")
    fs.writeFileSync(at("ragu.json"), JSON.stringify({ keybinds: {} }))
    const { config, deprecated } = await checks()
    expect(config).toMatchObject({ ok: true, detail: `${at("ragu.json")} parses as JSON` })
    expect(deprecated.ok).toBe(false)
    expect(deprecated.detail).toContain("keybinds")
  })

  test("config.json is not ragu's file: not read", async () => {
    fs.mkdirSync(Global.Path.config, { recursive: true })
    fs.writeFileSync(at("config.json"), "{ not json")
    const { config, deprecated } = await checks()
    expect(config).toMatchObject({ ok: true, detail: "no user config file (defaults in use)" })
    expect(deprecated.ok).toBe(true)
  })
})
