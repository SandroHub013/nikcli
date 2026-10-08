import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { adoptLegacyEnv, LEGACY_ENV_UNTIL } from "../../src/util/legacy-env"

describe("NIKCLI_* settings still reach ragu, until the compat goes", () => {
  test("a NIKCLI_X the user set becomes RAGU_X", () => {
    const env: Record<string, string | undefined> = { NIKCLI_CONFIG_CONTENT: "{}", NIKCLI_SERVER_PASSWORD: "p" }
    adoptLegacyEnv(env)
    expect(env.RAGU_CONFIG_CONTENT).toBe("{}")
    expect(env.RAGU_SERVER_PASSWORD).toBe("p")
  })

  test("a RAGU_X already set wins over the old name", () => {
    const env: Record<string, string | undefined> = { NIKCLI_CONFIG_CONTENT: "old", RAGU_CONFIG_CONTENT: "new" }
    adoptLegacyEnv(env)
    expect(env.RAGU_CONFIG_CONTENT).toBe("new")
  })

  test("an empty RAGU_X is a value the user set, not a gap", () => {
    const env: Record<string, string | undefined> = { NIKCLI_DISABLE_AUTOUPDATE: "1", RAGU_DISABLE_AUTOUPDATE: "" }
    adoptLegacyEnv(env)
    expect(env.RAGU_DISABLE_AUTOUPDATE).toBe("")
  })

  test("only the NIKCLI_ prefix is read, and the old names stay for whoever still reads them", () => {
    const env: Record<string, string | undefined> = { NIKCLIX: "a", MY_NIKCLI_X: "b", NIKCLI_X: "c" }
    adoptLegacyEnv(env)
    expect(Object.keys(env).sort()).toEqual(["MY_NIKCLI_X", "NIKCLIX", "NIKCLI_X", "RAGU_X"])
  })

  test("it runs before anything reads the environment: the first import of the entry", async () => {
    const entry = await fs.readFile(path.join(import.meta.dir, "../../src/index.ts"), "utf8")
    const first = entry.split("\n").find((line) => line.startsWith("import "))
    expect(first).toBe(`import "./util/legacy-env-run"`)
  })

  test(`the compat is removed by ${LEGACY_ENV_UNTIL}: past that day this test fails until it is`, () => {
    expect(LEGACY_ENV_UNTIL).toBe("2026-12-01")
    expect(Date.now()).toBeLessThan(Date.parse(`${LEGACY_ENV_UNTIL}T00:00:00Z`))
  })
})
