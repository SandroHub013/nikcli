import { preserveTestEnv } from "../helpers/env"
import { removeTestDir } from "../helpers/fs"
import { afterAll, describe, expect, it } from "bun:test"
import { Effect } from "effect"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { runPromiseWithLayer, withCurrentInstance } from "@/effect"
import { Instance } from "@/project/instance"

const testHome = await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-scratch-env-home-"))
process.env.NIKCLI_TEST_HOME = testHome
process.env.NIKCLI_DISABLE_EXTERNAL_SKILLS = "1"
process.env.XDG_DATA_HOME = path.join(testHome, "data")
process.env.XDG_CACHE_HOME = path.join(testHome, "cache")
process.env.XDG_CONFIG_HOME = path.join(testHome, "config")
process.env.XDG_STATE_HOME = path.join(testHome, "state")

preserveTestEnv([
  "NIKCLI_TEST_HOME",
  "NIKCLI_DISABLE_EXTERNAL_SKILLS",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
])

const { SystemPrompt } = await import("@/session/system")

const projectDirs: string[] = []

afterAll(async () => {
  await Instance.disposeAll().catch(() => undefined)
  await Promise.all(projectDirs.map((dir) => removeTestDir(dir)))
  await removeTestDir(testHome)
})

async function environment(dir: string): Promise<string[]> {
  return Instance.provide({
    directory: dir,
    fn: () =>
      runPromiseWithLayer(
        SystemPrompt.defaultLayer,
        withCurrentInstance(
          Effect.gen(function* () {
            const prompt = yield* SystemPrompt.Service
            return yield* prompt.environment()
          }),
        ),
      ),
  })
}

/**
 * A model that wants a throwaway file invents the temp path, and the invention
 * carries the wrong user: `C:\Users\ADMINI~1\AppData\Local\Temp` is the short
 * form of somebody else's account. In the `bunny-p5` sweep that was 9 of 16
 * failed calls. The temp dir is not guessable, so it is stated.
 */
describe("system prompt — the real temp dir", () => {
  it("puts it in the environment block, next to the working directory", async () => {
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-scratch-project-")))
    projectDirs.push(dir)

    // 1.417 splits the block in a static and a per-session part; the temp dir is in the second.
    const env = (await environment(dir)).join("\n")

    expect(env).toContain(`Working directory: ${dir}`)
    expect(env).toContain(`Temp dir: ${os.tmpdir()} (scratch files)`)
    // Inside `<env>`, so it costs one line rather than a paragraph.
    expect(env.slice(env.indexOf("<env>"), env.indexOf("</env>"))).toContain(`Temp dir: ${os.tmpdir()}`)
    expect(env).not.toContain("ADMINI~1")
  })
})
